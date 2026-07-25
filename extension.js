// -*- coding: utf-8-unix -*-
/* globals TextEncoder */

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

// Fallback poll interval in milliseconds, see _syncPoll().
const POLL_INTERVAL = 3000;

// https://github.com/GNOME/gnome-shell/blob/main/data/theme/gnome-shell-sass/widgets/_panel.scss
const PANEL_CSS = (bg, fg) => `
#panel { background-color: ${bg ?? "transparent"}; }
${bg ? `#panel * { color: ${fg}; }\n#panel .workspace-dot { background-color: ${fg}; }` : ""}
#panel:overview { background-color: transparent; }
#panel:overview * { color: white; }
#panel:overview .workspace-dot { background-color: white; }
`.trim();

export default class PanelColorMatcher extends Extension {

    enable() {
        // https://mutter.gnome.org/meta/class.Display.html#signals
        global.display.connectObject(
            "focus-window", () => this._updateDelayed(),
            this);

        // https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowManager.js
        global.window_manager.connectObject(
            "destroy",          () => this._updateDelayed(),
            "minimize",         () => this._updateDelayed(),
            "size-changed",     () => this._updateDelayed(),
            "switch-workspace", () => this._updateDelayed(),
            "unminimize",       () => this._updateDelayed(),
            this);

        this._settings = this.getSettings();
        this._settings.connectObject(
            "changed::poll-fallback-enabled", () => this._syncPoll(),
            this);
        this._dashSettings = this._getDashSettings();
        this._dashColor = null;
        this._stylesheet = null;
        this._stylesheetText = null;
        this._updateTimeout = null;
        this._pollTimeout = null;
        this._update();
        this._syncPoll();
    }

    disable() {
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        if (this._updateTimeout) {
            GLib.source_remove(this._updateTimeout);
            this._updateTimeout = null;
        }
        if (this._pollTimeout) {
            GLib.source_remove(this._pollTimeout);
            this._pollTimeout = null;
        }
        if (this._stylesheet) {
            this._unloadStyle();
            this._stylesheet.delete(null);
            this._stylesheet = null;
            this._stylesheetText = null;
        }
        if (this._dashSettings) {
            this._dashSettings.set_boolean("custom-background-color", false);
            this._dashSettings = null;
        }
        this._settings.disconnectObject(this);
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
                this._update();
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

    _applyStyle(bg, fg) {
        const stylesheetText = PANEL_CSS(bg, fg);
        if (stylesheetText === this._stylesheetText) return;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (this._stylesheet) {
            theme.unload_stylesheet(this._stylesheet);
        } else {
            this._stylesheet = Gio.File.new_for_path(`/tmp/${this.uuid}.css`);
        }
        this._stylesheet.replace_contents(
            new TextEncoder().encode(stylesheetText),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );
        this._stylesheetText = stylesheetText;
        theme.load_stylesheet(this._stylesheet);
    }

    _unloadStyle() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheet && theme.unload_stylesheet(this._stylesheet);
    }

    _updateDash(color) {
        if (!this._dashSettings) return;
        const hex = color && `#${[color.r, color.g, color.b]
            .map(c => c.toString(16).padStart(2, "0")).join("")}`;
        if (hex === this._dashColor) return;
        this._dashColor = hex;
        if (!hex) {
            this._dashSettings.set_boolean("custom-background-color", false);
            return;
        }
        this._dashSettings.set_string("background-color", hex);
        this._dashSettings.set_boolean("custom-background-color", true);
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
        const index = global.display.get_primary_monitor();
        const monitor = global.display.get_monitor_geometry(index);
        // Sample at 25% and 75% to detect half-maximized windows.
        const x1 = monitor.x + Math.floor(monitor.width * 0.25);
        const x2 = monitor.x + Math.floor(monitor.width * 0.75);
        const y  = monitor.y + Main.panel.height + 3;

        // No window below the panel, e.g. empty desktop: stay transparent
        // rather than matching the wallpaper.
        if (!this._hasWindowAt(x1, y) && !this._hasWindowAt(x2, y)) {
            this._applyStyle(null, null);
            this._updateDash(null);
            return;
        }

        this._captureStage().then(({texture, scale}) => Promise.all([
            this._sampleColor(texture, scale, x1, y),
            this._sampleColor(texture, scale, x2, y),
        ])).then(([color1, color2]) => {
            // In case one window is half-maximized either on the left or the
            // right side, find the side where the color is lightest or darkest,
            // since windows tend to be either light or dark and wallpapers
            // between. Also, note the chosen midpoint, which controls what
            // happens when one light window and one dark window are
            // half-maximized. Raising that value above 128 favors dark.
            const dist1 = Math.abs(color1.r-155) + Math.abs(color1.g-155) + Math.abs(color1.b-155);
            const dist2 = Math.abs(color2.r-155) + Math.abs(color2.g-155) + Math.abs(color2.b-155);
            const color = dist1 > dist2 ? color1 : color2;
            const luminance = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
            const bg = `rgb(${color.r}, ${color.g}, ${color.b})`;
            const fg = luminance > 128 ? "rgba(0, 0, 0, 0.9)" : "rgba(255, 255, 255, 0.9)";
            this._applyStyle(bg, fg);
            this._updateDash(color);
        }).catch(e => {
            console.error("Color sampling failed:", e);
        });
    }

    _updateDelayed() {
        this._updateTimeout && GLib.source_remove(this._updateTimeout);
        const delay = this._settings.get_int("update-delay");
        this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._update();
            this._updateTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

}
