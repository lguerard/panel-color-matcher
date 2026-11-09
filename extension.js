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
        // Undefined until the first update, then null for transparent.
        this._panelColor = undefined;
        this._panelStyle = Main.panel.get_style();
        this._inOverview = Main.overview.visible;
        this._updateTimeout = null;
        this._pollTimeout = null;
        // Incremented by each capture and by disable(), so that a capture
        // finishing late can tell it has been superseded.
        this._serial = 0;
        this._capturing = false;
        this._capturePending = false;

        // https://mutter.gnome.org/meta/class.Display.html#signals
        global.display.connectObject(
            "focus-window", () => this._updateDelayed(),
            "grab-op-end",  () => this._updateDelayed(),
            this);

        // https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowManager.js
        global.window_manager.connectObject(
            "destroy",          () => this._updateDelayed(),
            "map",              () => this._updateDelayed(),
            "minimize",         () => this._updateDelayed(),
            "size-changed",     () => this._updateDelayed(),
            "switch-workspace", () => this._updateDelayed(),
            "unminimize",       () => this._updateDelayed(),
            this);

        // The overview makes the panel transparent, which our inline
        // background color would override, so step aside while it's shown.
        Main.overview.connectObject(
            "showing", () => this._setInOverview(true),
            "hiding",  () => this._setInOverview(false),
            "hidden",  () => this._updateDelayed(),
            this);

        Main.layoutManager.connectObject(
            "monitors-changed", () => this._updateDelayed(),
            this);

        this._settings.connectObject(
            "changed::poll-fallback-enabled", () => this._syncPoll(),
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
        for (const name of ["_updateTimeout", "_pollTimeout", "_dashTimeout"]) {
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
        this._settings = null;
    }

    _getDashSettings() {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source.lookup(DASH_SCHEMA, true)) return null;
        return new Gio.Settings({schema_id: DASH_SCHEMA});
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

    async _captureStage() {
        // XXX: global.stage.read_pixels would be more appropriate.
        // https://gitlab.gnome.org/GNOME/mutter/-/issues/3622
        const screenshot = new Shell.Screenshot();
        const [content, scale] = await screenshot.screenshot_stage_to_content();
        return {texture: content.get_texture(), scale};
    }

    async _sampleColor(texture, scale, x, y) {
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture,
            x * scale,
            y * scale,
            1,
            1,
            scale,
            null,
            0,
            0,
            1,
            stream,
        );
        const pixels = pixbuf.get_pixels();
        return {r: pixels[0], g: pixels[1], b: pixels[2]};
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
        this._captureStage().then(({texture, scale}) => Promise.all([
            this._sampleColor(texture, scale, x1, y),
            this._sampleColor(texture, scale, x2, y),
        ])).then(([color1, color2]) => {
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
