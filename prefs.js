// -*- coding: utf-8-unix -*-

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import {ExtensionPreferences} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class PanelColorMatcherPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({title: "Behavior"});
        page.add(group);

        const row = new Adw.SpinRow({
            title: "Update delay",
            subtitle: "Milliseconds after a window event for a second, catch-all update, e.g. after a workspace switch animation",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        settings.bind("update-delay", row, "value", Gio.SettingsBindFlags.DEFAULT);
        group.add(row);

        const pollRow = new Adw.SwitchRow({
            title: "Periodic refresh fallback",
            subtitle: "Re-check the color every few seconds to catch changes that don't trigger a window event, e.g. a web page finishing loading. Uses a little extra battery.",
        });
        settings.bind("poll-fallback-enabled", pollRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(pollRow);

        const accentRow = new Adw.SwitchRow({
            title: "Match accent color",
            subtitle: "Set the system accent color to the preset closest to the panel color. Gray colors keep your own accent color.",
        });
        settings.bind("accent-color-enabled", accentRow, "active", Gio.SettingsBindFlags.DEFAULT);
        // GNOME 46 has no accent color setting.
        const interfaceSchema = Gio.SettingsSchemaSource.get_default()
            .lookup("org.gnome.desktop.interface", true);
        if (!interfaceSchema?.has_key("accent-color")) {
            accentRow.sensitive = false;
            accentRow.subtitle = "Requires GNOME 47 or later.";
        }
        group.add(accentRow);
    }

}
