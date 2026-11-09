// -*- coding: utf-8-unix -*-

import Adw from "gi://Adw";
import Gio from "gi://Gio";

import {ExtensionPreferences} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class PanelColorMatcherPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({title: "Behavior"});
        page.add(group);

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
