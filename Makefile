# -*- coding: utf-8-unix -*-

EXTENSION := panel-color-matcher@otsaloma.io
PACK_FILE := $(EXTENSION).shell-extension.zip
INSTALL_DIR := ~/.local/share/gnome-shell/extensions/$(EXTENSION)

check:
	jshint *.js

clean:
	rm -f $(PACK_FILE)

install:
	mkdir -p $(INSTALL_DIR)/schemas
	cp -f extension.js prefs.js metadata.json stylesheet.css $(INSTALL_DIR)
	cp -f schemas/*.gschema.xml $(INSTALL_DIR)/schemas
	glib-compile-schemas $(INSTALL_DIR)/schemas

pack: check clean
	gnome-extensions pack

run:
	dbus-run-session gnome-shell --devkit --wayland

.PHONY: check clean install pack run
