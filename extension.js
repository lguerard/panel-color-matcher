// -*- coding: utf-8-unix -*-

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

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

// Dash state for _writeDash(), when the panel is transparent.
const DASH_TRANSPARENT = "transparent";

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

// When the stage below the panel is repainted, wait until it has stayed
// unchanged for SETTLE_TIME milliseconds before sampling, so that window
// animations and apps drawing in several steps settle first. During
// continuous changes, e.g. scrolling or video, sample anyway after at most
// MAX_WAIT milliseconds.
const SETTLE_TIME = 100;
const MAX_WAIT = 500;

// Distance in pixels below the panel of the sampled points.
const SAMPLE_OFFSET = 3;

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
        // Undefined until the first sample, then null for transparent.
        this._panelColor = undefined;
        this._panelStyle = Main.panel.get_style();
        this._inOverview = Main.overview.visible;
        // Stage coordinates of the sampled points, see _syncPoints().
        this._points = null;
        // Monotonic times in microseconds of the first and the latest
        // unsampled change below the panel, see _queueSample().
        this._firstChange = null;
        this._lastChange = null;
        this._sampleTimeout = null;
        // Incremented by each sample and by disable(), so that a sample
        // finishing late can tell it has been superseded.
        this._serial = 0;
        this._sampling = false;
        this._samplePending = false;

        // The overview makes the panel transparent, which our inline
        // background color would override, so step aside while it's shown.
        Main.overview.connectObject(
            "showing", () => this._setInOverview(true),
            "hiding",  () => this._setInOverview(false),
            this);

        Main.layoutManager.connectObject(
            "monitors-changed", () => this._syncPoints(),
            this);

        Main.panel.connectObject(
            "notify::height", () => this._syncPoints(),
            this);

        this._settings.connectObject(
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

        // Rather than guessing from window manager events when what's below
        // the panel might have changed, which misses e.g. switching tabs in
        // a browser, watch the stage being repainted there. Whatever the
        // cause, a change on screen is a repaint, and with nothing changing
        // there are no repaints, so this costs nothing when idle.
        global.stage.connectObject(
            "paint-view", (stage, view, clip) => this._onPaintView(clip),
            this);

        // During shell startup the panel isn't laid out yet and the stage
        // can't be sampled, so wait until startup is complete.
        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                "startup-complete", () => this._syncPoints(),
                this);
        } else {
            this._syncPoints();
        }
    }

    disable() {
        this._serial++;
        global.stage.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._interfaceSettings?.disconnectObject(this);
        for (const name of ["_sampleTimeout", "_dashTimeout", "_accentTimeout"]) {
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
        this._points = null;
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

    // Sample at 25% and 75% of the primary monitor's width, right below the
    // panel, to detect half-maximized windows.
    _syncPoints() {
        const index = global.display.get_primary_monitor();
        const monitor = global.display.get_monitor_geometry(index);
        const y = monitor.y + Main.panel.height + SAMPLE_OFFSET;
        this._points = [
            [monitor.x + Math.floor(monitor.width * 0.25), y],
            [monitor.x + Math.floor(monitor.width * 0.75), y],
        ];
        this._queueSample();
    }

    // Called for every repaint of every monitor, so keep this cheap. clip is
    // the repainted region of the stage, in stage coordinates.
    _onPaintView(clip) {
        if (!this._points || this._inOverview) return;
        if (clip && !this._points.some(([x, y]) => clip.contains_point(x, y))) return;
        this._queueSample();
    }

    _queueSample() {
        const now = GLib.get_monotonic_time();
        if (this._firstChange === null) this._firstChange = now;
        this._lastChange = now;
        if (!this._sampleTimeout) this._scheduleSample(SETTLE_TIME);
    }

    // Rather than rescheduling on every repaint, check when the timeout
    // fires whether to wait more.
    _scheduleSample(delay) {
        this._sampleTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._sampleTimeout = null;
            const now = GLib.get_monotonic_time();
            const settleLeft = SETTLE_TIME - (now - this._lastChange) / 1000;
            const waitLeft = MAX_WAIT - (now - this._firstChange) / 1000;
            if (settleLeft > 0 && waitLeft > 0) {
                this._scheduleSample(Math.ceil(Math.min(settleLeft, waitLeft)));
            } else {
                this._firstChange = null;
                this._sample();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Paints just the one pixel at x, y of the stage to a buffer and reads
    // it back, with no full-stage capture, no wait for the next frame and no
    // image encoding. This is what GNOME's own color picker uses. It paints
    // offscreen, so it doesn't emit paint-view, which would loop.
    // https://github.com/GNOME/gnome-shell/blob/main/src/shell-screenshot.c
    async _pickColor(x, y) {
        // Each pick stores its result in the screenshot object,
        // so use a new one for every pick.
        const screenshot = new Shell.Screenshot();
        const [color] = await screenshot.pick_color(x, y);
        return {r: color.red, g: color.green, b: color.blue};
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

    _sample() {
        if (!this._points || this._inOverview) return;
        // Avoid overlapping samples, but sample again once the one in
        // progress is done, since it might be outdated already.
        if (this._sampling) {
            this._samplePending = true;
            return;
        }

        // No window below the panel, e.g. empty desktop: stay transparent
        // rather than matching the wallpaper.
        if (!this._points.some(([x, y]) => this._hasWindowAt(x, y))) {
            this._applyColor(null);
            return;
        }

        const serial = ++this._serial;
        this._sampling = true;
        Promise.all(this._points.map(([x, y]) => this._pickColor(x, y))).then(([color1, color2]) => {
            // Disabled or superseded while sampling.
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
            this._sampling = false;
            if (this._samplePending) {
                this._samplePending = false;
                this._sample();
            }
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
            // Follow the panel: its color, or transparent when it is.
            this._writeDash(this._panelColor ? toHex(this._panelColor) : DASH_TRANSPARENT);
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

    // Set the dash to a color as a hex string, to fully transparent with
    // DASH_TRANSPARENT, or null to restore the user's own settings.
    _writeDash(state) {
        if (state === this._dashColor) return;
        const settings = this._dashSettings;
        if (!this._dashOriginal) {
            this._dashOriginal = {
                custom: settings.get_boolean("custom-background-color"),
                color: settings.get_string("background-color"),
                mode: settings.get_string("transparency-mode"),
                opacity: settings.get_double("background-opacity"),
            };
        }
        const original = this._dashOriginal;
        const transparent = state === DASH_TRANSPARENT;
        const color = state && !transparent;
        // Write all keys at once, so Dash to Dock restyles only once.
        // A fixed opacity of zero makes the dash background invisible
        // whatever its color, in all of Dash to Dock's transparency modes.
        settings.delay();
        settings.set_boolean("custom-background-color", color ? true : original.custom);
        settings.set_string("background-color", color ? state : original.color);
        settings.set_string("transparency-mode", transparent ? "FIXED" : original.mode);
        settings.set_double("background-opacity", transparent ? 0 : original.opacity);
        settings.apply();
        this._dashColor = state;
        if (!state) this._dashOriginal = null;
    }

}
