Panel Color Matcher GNOME Shell Extension
=========================================

Panel Color Matcher is a GNOME Shell extension to dynamically change the
top panel color to match the window below it. With no window below the
panel, e.g. on an empty desktop, the panel stays transparent. If Dash to
Dock (or Ubuntu Dock) is installed, its background follows the panel color,
including being transparent with the panel. Your own dock settings are
restored when a window is below the panel again or the extension is disabled.
Optionally, on GNOME 47 and later, the system accent color can follow
the panel color too, using the closest of GNOME's preset accent colors.

This is a fork of [otsaloma/panel-color-matcher][upstream], which is
available at [extensions.gnome.org][ego]. The fork has its own UUID,
`panel-color-matcher@lguerard.github.io`, so that updates to the
original never replace it. Don't enable both at the same time, they
would fight over the panel. Both use the same settings, so preferences
carry over.

[upstream]: https://github.com/otsaloma/panel-color-matcher
[ego]: https://extensions.gnome.org/extension/9260/panel-color-matcher/

## Installing

To install from the source repository, run

```bash
gnome-extensions pack --force
gnome-extensions install --force panel-color-matcher@lguerard.github.io.shell-extension.zip
```

or `make install`. Log out and back in, then activate in the GNOME
Extensions app or Extension Manager.

`make check` lints the code and needs [JSHint](https://jshint.com/)
(`npm install -g jshint`).

## How It Works

GNOME only repaints the parts of the screen that change. The extension
watches for repaints of the two points right below the panel that it
samples, at 25% and 75% of the width, whatever caused them: a window
being opened, moved or closed, switching tabs in a browser, a page
loading, and so on. Once those points have stayed unchanged for 100 ms,
or at the latest after 500 ms of continuous changes such as video, it
reads the two pixels with GNOME's color picker and sets the color
directly on the panel, without reloading the shell theme. When nothing
below the panel changes, the extension does nothing.

## Known Issues

* Dash to Dock restyles itself whenever its background color changes.
  Some Dash to Dock versions "tremble" and sometimes swap the order of
  non-pinned open apps in the dock when restyling. This is a bug in Dash
  to Dock, see micheleg/dash-to-dock#2383 for a description and a fix.

## Screenshots

Light window maximized:
![screenshot](screenshots/screenshot-light.png)

Dark window maximized:
![screenshot](screenshots/screenshot-dark.png)

Any color window maximized:
![screenshot](screenshots/screenshot-gimp.png)
![screenshot](screenshots/screenshot-brave.png)
