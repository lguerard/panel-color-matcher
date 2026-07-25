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
            subtitle: "Milliseconds to wait after a window event before sampling and applying the panel color",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 50,
                page_increment: 100,
            }),
        });
        settings.bind("update-delay", row, "value", Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }

}
