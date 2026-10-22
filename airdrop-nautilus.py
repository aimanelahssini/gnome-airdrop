# Files (Nautilus) right-click → "Send with AirDrop": hands the selected files to the AirDrop
# GNOME extension, which shows the nearby devices to pick from.
# Installed to ~/.local/share/nautilus-python/extensions/ (needs the nautilus-python package).
import gi
gi.require_version("Nautilus", "4.1")
from gi.repository import Gio, GLib, GObject, Nautilus  # noqa: E402


class AirDropMenu(GObject.GObject, Nautilus.MenuProvider):
    def get_file_items(self, files):
        paths = []
        for f in files:
            if f.get_uri_scheme() != "file" or f.is_directory():
                return []
            paths.append(f.get_location().get_path())
        if not paths:
            return []
        item = Nautilus.MenuItem(name="AirDrop::send", label="Send with AirDrop…",
                                 tip="Send to a nearby iPhone with AirDrop")
        item.connect("activate", self._send, paths)
        return [item]

    def _send(self, _item, paths):
        Gio.bus_get_sync(Gio.BusType.SESSION).call(
            "org.gnome.Shell", "/io/github/aimanelahssini/AirDrop",
            "io.github.aimanelahssini.AirDrop", "SendFiles",
            GLib.Variant("(as)", (paths,)), None, Gio.DBusCallFlags.NONE, -1, None, None)
