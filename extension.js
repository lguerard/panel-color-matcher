// -*- coding: utf-8-unix -*-

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {Extension} from "resource:///org/gnome/shell/extensions/extension.js";

// Dash to Dock and its Ubuntu fork both use this schema for a custom,
// non-theme dash background color.
const DASH_SCHEMA = "org.gnome.shell.extensions.dash-to-dock";

// Delay in milliseconds before following a panel color change in the dash.
// Changing the dash color writes to dconf and makes Dash to Dock restyle
// itself, so do it after the panel has been updated, and only once when the
// color changes several times in quick succession.
const DASH_DELAY = 300;

// Delay in milliseconds before following a panel color change in the
// system accent color. Changing the accent color restyles the whole shell
// and all apps, so only do it once the color has settled.
const ACCENT_DELAY = 1000;

// GNOME's accent colors (GNOME 47 and later) only come as a fixed set.
// https://gitlab.gnome.org/GNOME/libadwaita/-/blob/main/src/adw-accent-color.c
const ACCENT_COLORS = {
    blue:   {r: 0x35, g: 0x84, b: 0xe4},
    teal:   {r: 0x21, g: 0x90, b: 0xa4},
    green:  {r: 0x3a, g: 0x94, b: 0x4a},
    yellow: {r: 0xc8, g: 0x88, b: 0x00},
    orange: {r: 0xed, g: 0x5b, b: 0x00},
    red:    {r: 0xe6, g: 0x2d, b: 0x42},
    pink:   {r: 0xd5, g: 0x61, b: 0x99},
    purple: {r: 0x91, g: 0x41, b: 0xac},
};

// Colors with less chroma than this (0-255) count as gray, e.g. most light
// and dark windows, which shouldn't change the accent color.
const ACCENT_MIN_CHROMA = 48;

const INTERFACE_SCHEMA = "org.gnome.desktop.interface";

// Fallback poll interval in milliseconds, see _syncPoll().
const POLL_INTERVAL = 3000;

// Style classes defined in stylesheet.css.
const CLASS_TRANSPARENT = "panel-color-matcher-transparent";
const CLASS_DARK_TEXT = "panel-color-matcher-dark-text";
const CLASS_LIGHT_TEXT = "panel-color-matcher-light-text";

// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function relativeLuminance({r, g, b}) {
    const linear = c => {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// Return true if black text has better contrast on color than white text.
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
function prefersDarkText(color) {
    const luminance = relativeLuminance(color);
    return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05);
}

// Hue in degrees, 0-360.
function hue({r, g, b}) {
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma === 0) return 0;
    const h = max === r ? (g - b) / chroma % 6 :
        max === g ? (b - r) / chroma + 2 :
        (r - g) / chroma + 4;
    return (h * 60 + 360) % 360;
}

// Return the name of the accent color closest in hue to color,
// null if color is too gray to have a meaningful hue.
function nearestAccentColor(color) {
    const chroma = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
    if (chroma < ACCENT_MIN_CHROMA) return null;
    const h = hue(color);
    const distance = name => {
        const d = Math.abs(hue(ACCENT_COLORS[name]) - h);
        return Math.min(d, 360 - d);
    };
    return Object.keys(ACCENT_COLORS).reduce((a, b) => distance(a) <= distance(b) ? a : b);
}

function toHex({r, g, b}) {
    return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

export default class PanelColorMatcher extends Extension {

    enable() {
        this._settings = this.getSettings();
        this._dashSettings = this._getDashSettings();
        this._dashOriginal = null;
        this._dashColor = null;
        this._dashTimeout = null;
        this._interfaceSettings = this._getInterfaceSettings();
        this._accentOriginal = null;
        this._accentColor = null;
        this._accentTimeout = null;
        // Undefined until the first update, then null for transparent.
        this._panelColor = undefined;
        this._panelStyle = Main.panel.get_style();
        this._inOverview = Main.overview.visible;
        this._updateTimeout = null;
        this._pollTimeout = null;
        this._laterId = null;
        this._idleId = null;
        // Window actors with a window manager animation in progress, mapped
        // to a timeout to stop waiting for it, see _waitForEffect().
        this._animating = new Map();
        // Incremented by each capture and by disable(), so that a capture
        // finishing late can tell it has been superseded.
        this._serial = 0;
        this._capturing = false;
        this._capturePending = false;

        // Events that change what's below the panel right away, without an
        // animation: sample on the next frame.
        // https://mutter.gnome.org/meta/class.Display.html#signals
        global.display.connectObject(
            "focus-window", () => this._updateNow(),
            "grab-op-end",  () => this._updateNow(),
            this);

        // Events that start a window animation: sample as soon as the
        // animation is complete. The workspace switch animation gives no
        // signal when complete, so rely on the delayed update for it.
        // https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowManager.js
        global.window_manager.connectObject(
            "destroy",          (wm, actor) => this._waitForEffect(actor, "destroy"),
            "map",              (wm, actor) => this._waitForEffect(actor, "effects-completed"),
            "minimize",         (wm, actor) => this._waitForEffect(actor, "effects-completed"),
            "size-change",      (wm, actor) => this._waitForEffect(actor, "effects-completed"),
            "size-changed",     () => this._updateNow(),
            "switch-workspace", () => this._updateDelayed(),
            "unminimize",       (wm, actor) => this._waitForEffect(actor, "effects-completed"),
            this);

        // The overview makes the panel transparent, which our inline
        // background color would override, so step aside while it's shown.
        Main.overview.connectObject(
            "showing", () => this._setInOverview(true),
            "hiding",  () => this._setInOverview(false),
            "hidden",  () => this._updateNow(),
            this);

        Main.layoutManager.connectObject(
            "monitors-changed", () => this._updateDelayed(),
            this);

        this._settings.connectObject(
            "changed::poll-fallback-enabled", () => this._syncPoll(),
            "changed::accent-color-enabled", () => this._updateAccentDelayed(),
            this);

        // If the user picks an accent color themselves while we're
        // overriding it, keep theirs as the one to restore.
        this._interfaceSettings?.connectObject(
            "changed::accent-color", () => {
                if (this._interfaceSettings.get_string("accent-color") === this._accentColor) return;
                this._accentOriginal = null;
                this._accentColor = null;
            },
            this);

        // During shell startup the panel isn't laid out yet and the stage
        // can't be captured, so wait until startup is complete.
        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                "startup-complete", () => this._update(),
                this);
        } else {
            this._update();
        }
        this._syncPoll();
    }

    disable() {
        this._serial++;
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._interfaceSettings?.disconnectObject(this);
        for (const actor of [...this._animating.keys()])
            this._stopWaitingForEffect(actor, false);
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = null;
        }
        for (const name of ["_updateTimeout", "_pollTimeout", "_dashTimeout", "_accentTimeout", "_idleId"]) {
            if (this[name]) {
                GLib.source_remove(this[name]);
                this[name] = null;
            }
        }
        Main.panel.remove_style_class_name(CLASS_TRANSPARENT);
        Main.panel.remove_style_class_name(CLASS_DARK_TEXT);
        Main.panel.remove_style_class_name(CLASS_LIGHT_TEXT);
        Main.panel.set_style(this._panelStyle);
        this._panelStyle = null;
        this._panelColor = undefined;
        if (this._dashSettings) {
            this._writeDash(null);
            this._dashSettings = null;
        }
        if (this._interfaceSettings) {
            this._writeAccent(null);
            this._interfaceSettings = null;
        }
        this._settings = null;
    }

    _getDashSettings() {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source.lookup(DASH_SCHEMA, true)) return null;
        return new Gio.Settings({schema_id: DASH_SCHEMA});
    }

    // Return null on GNOME 46, which has no accent color setting.
    _getInterfaceSettings() {
        const settings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
        return settings.settings_schema.has_key("accent-color") ? settings : null;
    }

    // Fallback for content-only changes that don't fire any of the
    // window-manager signals connected in enable(), e.g. a web page
    // finishing loading in an already-focused, unresized browser window.
    // Optional since it wakes the system periodically, costing battery.
    _syncPoll() {
        const enabled = this._settings.get_boolean("poll-fallback-enabled");
        if (enabled && !this._pollTimeout) {
            this._pollTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => {
                // A delayed update is coming anyway.
                if (!this._updateTimeout) this._update();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!enabled && this._pollTimeout) {
            GLib.source_remove(this._pollTimeout);
            this._pollTimeout = null;
        }
    }

    // Paints just the one pixel at x, y of the stage to a buffer and reads
    // it back, with no full-stage capture, no wait for the next frame and no
    // image encoding. This is what GNOME's own color picker uses.
    // https://github.com/GNOME/gnome-shell/blob/main/src/shell-screenshot.c
    async _sampleColor(x, y) {
        // Each pick stores its result in the screenshot object,
        // so use a new one for every pick.
        const screenshot = new Shell.Screenshot();
        const [color] = await screenshot.pick_color(x, y);
        return {r: color.red, g: color.green, b: color.blue};
    }

    // Sample once the window manager animation of actor is complete,
    // signalled by signal on actor. The delayed update covers any missed
    // signal, e.g. when GNOME Shell decides not to animate a window.
    _waitForEffect(actor, signal) {
        this._updateDelayed();
        if (!St.Settings.get().enable_animations || Main.overview.visible) {
            this._updateNow();
            return;
        }
        if (this._animating.has(actor)) return;
        const delay = this._settings.get_int("update-delay");
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._animating.delete(actor);
            this._stopWaitingForEffect(actor, true);
            return GLib.SOURCE_REMOVE;
        });
        this._animating.set(actor, timeout);
        actor.connectObject(signal, () => this._stopWaitingForEffect(actor, true), this);
    }

    _stopWaitingForEffect(actor, update) {
        const timeout = this._animating.get(actor);
        timeout && GLib.source_remove(timeout);
        this._animating.delete(actor);
        actor.disconnectObject(this);
        if (update && this._animating.size === 0) this._updateNow();
    }

    // Sample right after the next frame, once the window stacking, focus
    // and geometry changes from the current event are reflected on stage.
    // Skipped while animations are running, those trigger an update on
    // completion.
    _updateNow() {
        if (this._laterId || this._idleId) return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = null;
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = null;
                if (this._animating.size === 0) this._update();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _setInOverview(inOverview) {
        this._inOverview = inOverview;
        this._renderPanel();
    }

    // Set the panel color, null for transparent.
    _applyColor(color) {
        const old = this._panelColor;
        if (old === color || (old && color &&
            old.r === color.r && old.g === color.g && old.b === color.b))
            return;
        this._panelColor = color;
        this._renderPanel();
        this._updateDashDelayed();
        this._updateAccentDelayed();
    }

    // Only touches the panel's style classes and inline style, which
    // restyles just the panel rather than reloading the whole theme.
    _renderPanel() {
        const color = this._inOverview ? undefined : this._panelColor;
        const darkText = color ? prefersDarkText(color) : false;
        const classes = {
            [CLASS_TRANSPARENT]: color === null,
            [CLASS_DARK_TEXT]: !!color && darkText,
            [CLASS_LIGHT_TEXT]: !!color && !darkText,
        };
        for (const [name, enabled] of Object.entries(classes)) {
            if (enabled) Main.panel.add_style_class_name(name);
            else Main.panel.remove_style_class_name(name);
        }
        const style = color ?
            `background-color: rgb(${color.r}, ${color.g}, ${color.b});` :
            this._panelStyle;
        Main.panel.set_style(style);
    }

    _updateDashDelayed() {
        if (!this._dashSettings || this._dashTimeout) return;
        this._dashTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, DASH_DELAY, () => {
            this._dashTimeout = null;
            this._writeDash(this._panelColor && toHex(this._panelColor));
            return GLib.SOURCE_REMOVE;
        });
    }

    // Unlike the dash, restart the delay on every change, so that the accent
    // color, which is expensive to change, only follows a settled color.
    _updateAccentDelayed() {
        if (!this._interfaceSettings) return;
        this._accentTimeout && GLib.source_remove(this._accentTimeout);
        this._accentTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ACCENT_DELAY, () => {
            this._accentTimeout = null;
            const enabled = this._settings.get_boolean("accent-color-enabled");
            this._writeAccent(enabled && this._panelColor ? nearestAccentColor(this._panelColor) : null);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Set the accent color, null to restore the user's own.
    _writeAccent(name) {
        if (name === this._accentColor) return;
        const settings = this._interfaceSettings;
        this._accentOriginal = this._accentOriginal ?? settings.get_string("accent-color");
        this._accentColor = name;
        settings.set_string("accent-color", name ?? this._accentOriginal);
        if (!name) this._accentOriginal = null;
    }

    // Set the dash color, null to restore the user's own settings.
    _writeDash(hex) {
        if (hex === this._dashColor) return;
        const settings = this._dashSettings;
        if (!this._dashOriginal) {
            this._dashOriginal = {
                custom: settings.get_boolean("custom-background-color"),
                color: settings.get_string("background-color"),
            };
        }
        // Write both keys at once, so Dash to Dock restyles only once.
        settings.delay();
        settings.set_boolean("custom-background-color", hex ? true : this._dashOriginal.custom);
        settings.set_string("background-color", hex ?? this._dashOriginal.color);
        settings.apply();
        this._dashColor = hex;
        if (!hex) this._dashOriginal = null;
    }

    _hasWindowAt(x, y) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace).some(win => {
            if (win.minimized) return false;
            const rect = win.get_frame_rect();
            return x >= rect.x && x < rect.x + rect.width &&
                   y >= rect.y && y < rect.y + rect.height;
        });
    }

    _update() {
        // The overview hides the windows, sample again once it's hidden.
        if (this._inOverview) return;
        // Avoid stacking up captures, but make sure to sample again once
        // the one in progress is done, since it might be outdated already.
        if (this._capturing) {
            this._capturePending = true;
            return;
        }

        const index = global.display.get_primary_monitor();
        const monitor = global.display.get_monitor_geometry(index);
        // Sample at 25% and 75% to detect half-maximized windows.
        const x1 = monitor.x + Math.floor(monitor.width * 0.25);
        const x2 = monitor.x + Math.floor(monitor.width * 0.75);
        const y  = monitor.y + Main.panel.height + 3;

        // No window below the panel, e.g. empty desktop: stay transparent
        // rather than matching the wallpaper.
        if (!this._hasWindowAt(x1, y) && !this._hasWindowAt(x2, y)) {
            this._applyColor(null);
            return;
        }

        const serial = ++this._serial;
        this._capturing = true;
        Promise.all([
            this._sampleColor(x1, y),
            this._sampleColor(x2, y),
        ]).then(([color1, color2]) => {
            // Disabled or superseded while capturing.
            if (serial !== this._serial) return;
            // In case one window is half-maximized either on the left or the
            // right side, find the side where the color is lightest or darkest,
            // since windows tend to be either light or dark and wallpapers
            // between. Also, note the chosen midpoint, which controls what
            // happens when one light window and one dark window are
            // half-maximized. Raising that value above 128 favors dark.
            const dist1 = Math.abs(color1.r-155) + Math.abs(color1.g-155) + Math.abs(color1.b-155);
            const dist2 = Math.abs(color2.r-155) + Math.abs(color2.g-155) + Math.abs(color2.b-155);
            this._applyColor(dist1 > dist2 ? color1 : color2);
        }).catch(e => {
            console.error("Color sampling failed:", e);
        }).finally(() => {
            if (serial !== this._serial) return;
            this._capturing = false;
            if (this._capturePending) {
                this._capturePending = false;
                this._update();
            }
        });
    }

    _updateDelayed() {
        this._updateTimeout && GLib.source_remove(this._updateTimeout);
        const delay = this._settings.get_int("update-delay");
        this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._updateTimeout = null;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

}
