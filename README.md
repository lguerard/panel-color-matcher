Panel Color Matcher GNOME Shell Extension
=========================================

[![Downloads](https://img.shields.io/gnome-extensions/dt/panel-color-matcher@otsaloma.io)](https://extensions.gnome.org/extension/9260/panel-color-matcher/)

Panel Color Matcher is a GNOME Shell extension to dynamically change the
top panel color to match the window below it. With no window below the
panel, e.g. on an empty desktop, the panel stays transparent. If Dash to
Dock is installed, its background follows the panel color.

## Installing

Panel Color Matcher is available at ego:
https://extensions.gnome.org/extension/9260/panel-color-matcher/

### Developers

To install from the source repository during development, run

```bash
make install
```

Activate in the GNOME Extensions app.

`make check` lints the code and needs [JSHint](https://jshint.com/)
(`npm install -g jshint`).

## Known Issues

This extension uses programmatic single-pixel screenshots to sample
colors right below the panel. When that color is different than before,
it is set directly on the panel, without reloading the shell theme. This
works, but has some minor problems.

* Dash to Dock restyles itself whenever its background color changes.
  Some Dash to Dock versions "tremble" and sometimes swap the order of
  non-pinned open apps in the dock when restyling. This is a bug in Dash
  to Dock, see micheleg/dash-to-dock#2383 for a description and a fix.

* The color sampling uses more CPU than we'd like. It shouldn't be an
  issue on any modern multi-core system, but if you have a very
  low-power system, you might want to avoid this.

## Screenshots

Light window maximized:
![screenshot](screenshots/screenshot-light.png)

Dark window maximized:
![screenshot](screenshots/screenshot-dark.png)

Any color window maximized:
![screenshot](screenshots/screenshot-gimp.png)
![screenshot](screenshots/screenshot-brave.png)
