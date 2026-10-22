// AirDrop with iPhones from Quick Settings, through Owly (https://github.com/t4t5/owly).
//
// Owly's CLI asks "accept? [y/N]" on its terminal and declines by itself after 15 s, so this
// runs `owly receive` in the background, reads its questions and answers them from Accept /
// Decline notifications. The radio always goes up with a time limit (`--for`), enforced by
// owlyd itself, so Wi-Fi comes back even if GNOME Shell or this extension goes away.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ON_MINUTES = 10;          // AirDrop turns itself off (and Wi-Fi comes back) after this
const ASK_SECONDS = 14;         // Owly declines by itself after 15 s
const DONE_SECONDS = 15;        // after a transfer, turn off (Wi-Fi back) unless another one starts
const WIFI_CHECK_SECONDS = 8;   // after the radio stops, make sure Wi-Fi reconnected
const BROWSE_SECONDS = 6;
const SIGINT = 2;

const DBUS_XML = `
<node>
  <interface name="io.github.aimanelahssini.AirDrop">
    <method name="Toggle"/>
    <method name="SendFiles"><arg type="as" direction="in" name="paths"/></method>
    <method name="ChooseAndSend"/>
  </interface>
</node>`;

function log(msg) {
    console.log(`airdrop: ${msg}`);
}

function deviceName() {
    try {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'airdrop', 'name']);
        const name = new TextDecoder().decode(GLib.file_get_contents(path)[1]).trim();
        if (name)
            return name;
    } catch {}
    return 'ThinkPad';
}

// Owly prints names with Rust's {:?}: "Jane\"s iPhone". JSON reads that.
function unquote(s) {
    try {
        return JSON.parse(s);
    } catch {
        return s.replace(/^"|"$/g, '');
    }
}

// Reads a subprocess pipe line by line.
function readLines(stream, onLine, onEnd) {
    const data = new Gio.DataInputStream({base_stream: stream, close_base_stream: true});
    const next = () => data.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch {
            line = null;
        }
        if (line === null) {
            onEnd?.();
            return;
        }
        onLine(line);
        next();
    });
    next();
}

function spawn(argv, flags) {
    const launcher = new Gio.SubprocessLauncher({flags});
    launcher.setenv('NO_COLOR', '1', true);
    return launcher.spawnv(argv);
}

// The top-bar icon shown while AirDrop is on.
const AirDropIndicator = GObject.registerClass(
class AirDropIndicator extends QuickSettings.SystemIndicator {
    _init(ext) {
        super._init();
        this._icon = this._addIndicator();
        this._icon.gicon = ext.symbolicIcon;
        this._icon.visible = false;
    }

    sync(on) {
        this._icon.visible = on;
    }
});

export default class AirDropExtension extends Extension {
    enable() {
        this.icon = Gio.FileIcon.new(this.dir.get_child('icons').get_child('airdrop.svg'));
        this.symbolicIcon = Gio.FileIcon.new(this.dir.get_child('icons').get_child('airdrop-symbolic.svg'));
        this._radio = null;         // `owly radio up --for`
        this._receiver = null;      // `owly receive`
        this._receiving = false;
        this._sending = 0;
        this._offAt = 0;
        this._indicator = new AirDropIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._addButton();
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, {
            Toggle: () => this.toggle(),
            SendFiles: paths => this.sendFiles(paths),
            ChooseAndSend: () => this.chooseAndSend(),
        });
        this._dbus.export(Gio.DBus.session, '/io/github/aimanelahssini/AirDrop');
        this._sync();
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = null;
        this._cancelDone();
        if (this._wifiCheck)
            GLib.source_remove(this._wifiCheck);
        this._wifiCheck = null;
        this._stopAll();
        this._dialog?.close();
        this._source?.destroy();
        this._source = null;
        if (this._buttonRetry)
            GLib.source_remove(this._buttonRetry);
        this._buttonRetry = null;
        this._button?.destroy();
        this._button = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // A round button in Quick Settings' top row, right after Take Screenshot, styled like it.
    // Quick Settings builds that row asynchronously at login, so wait for it.
    _addButton() {
        const row = Main.panel.statusArea.quickSettings._system?._systemItem?.child;
        const shot = row?.get_children().find(c => c.icon_name === 'screenshooter-symbolic');
        if (!shot) {
            this._buttonRetry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._buttonRetry = null;
                this._addButton();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._button = new St.Button({
            style_class: 'icon-button airdrop-button',
            can_focus: true,
            child: new St.Icon({gicon: this.symbolicIcon}),
            accessible_name: 'AirDrop',
        });
        this._button.connect('clicked', () => this.toggle());
        row.insert_child_above(this._button, shot);
        this._sync();
    }

    // ---- state -----------------------------------------------------------------------
    _sync() {
        if (!this._indicator)
            return;
        const on = !!this._radio;
        this._indicator.sync(on);
        if (this._button) {
            if (on)
                this._button.add_style_pseudo_class('checked');
            else
                this._button.remove_style_pseudo_class('checked');
            const left = Math.max(1, Math.ceil((this._offAt - GLib.get_monotonic_time()) / 60e6));
            this._button.accessible_name = on ? `AirDrop on, turns off in ${left} min` : 'AirDrop off';
        }
    }

    _notify(title, body, {urgency = MessageTray.Urgency.NORMAL, actions = [], transient = false} = {}) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'AirDrop', icon: this.icon});
            this._source.connect('destroy', () => { this._source = null; });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title, body, urgency,
            isTransient: transient, gicon: this.icon});
        for (const [label, cb] of actions)
            n.addAction(label, cb);
        this._source.addNotification(n);
        return n;
    }

    toggle() {
        if (this._receiving)
            this.stop();
        else
            this.startReceiving();
    }

    // ---- radio -----------------------------------------------------------------------
    // Resolves once the AWDL interface is up; the radio goes down by itself after ON_MINUTES.
    _radioUp() {
        if (this._radioReady)
            return this._radioReady;
        this._radioReady = new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(['owly', 'radio', 'up', '--for', String(ON_MINUTES * 60)],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                this._radioReady = null;
                reject(new Error(`Owly isn't installed (${e.message})`));
                return;
            }
            this._radio = proc;
            this._offAt = GLib.get_monotonic_time() + ON_MINUTES * 60e6;
            let up = false;
            const lines = [];
            readLines(proc.get_stderr_pipe(), line => {
                lines.push(line);
                if (!up && /awdl0 is up/.test(line)) {
                    up = true;
                    resolve();
                }
            });
            proc.wait_async(null, () => {
                log(`radio down: ${lines.slice(-1)[0] ?? ''}`);
                this._ensureWifi();
                const wasOn = this._radio === proc;
                this._radio = null;
                this._radioReady = null;
                if (!up)
                    reject(new Error(lines.slice(-1)[0] || 'the radio did not start (try: owly doctor)'));
                if (wasOn) {
                    this._stopReceiver();
                    this._sync();
                    this._notify('AirDrop is off', 'Wi-Fi is back.', {transient: true});
                }
            });
            this._sync();
        });
        return this._radioReady;
    }

    // owlyd hands the card back to NetworkManager when the radio stops, and Wi-Fi normally
    // reconnects within a second. If it hasn't after a few seconds, ask NetworkManager to.
    _ensureWifi() {
        if (this._wifiCheck)
            GLib.source_remove(this._wifiCheck);
        this._wifiCheck = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WIFI_CHECK_SECONDS, () => {
            this._wifiCheck = null;
            if (this._radio)
                return GLib.SOURCE_REMOVE;  // AirDrop was turned on again meanwhile
            try {
                const p = spawn(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'device'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                p.communicate_utf8_async(null, null, (pp, res) => {
                    const [, out] = pp.communicate_utf8_finish(res);
                    for (const line of (out ?? '').split('\n')) {
                        const [dev, type, state] = line.split(':');
                        if (type === 'wifi' && (state === 'disconnected' || state === 'unmanaged')) {
                            log(`Wi-Fi ${dev} is ${state}; reconnecting`);
                            if (state === 'unmanaged')
                                spawn(['nmcli', 'device', 'set', dev, 'managed', 'yes'], Gio.SubprocessFlags.NONE);
                            spawn(['nmcli', 'device', 'connect', dev], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                        }
                    }
                });
            } catch (e) {
                log(`Wi-Fi check failed: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // After a transfer finishes, turn AirDrop off so Wi-Fi comes back, unless another
    // request comes in meanwhile.
    _scheduleDone() {
        this._cancelDone();
        this._doneTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DONE_SECONDS, () => {
            this._doneTimer = null;
            if (this._receiving && !this._askNotification && !this._sending) {
                this._stopAll();
                this._sync();
                this._notify('AirDrop is off', 'Transfer done. Wi-Fi is back.', {transient: true});
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDone() {
        if (this._doneTimer)
            GLib.source_remove(this._doneTimer);
        this._doneTimer = null;
    }

    _stopAll() {
        this._cancelDone();
        this._stopReceiver();
        if (this._radio) {
            const radio = this._radio;
            this._radio = null;
            this._radioReady = null;
            try { radio.send_signal(SIGINT); } catch {}
        }
    }

    stop() {
        const wasOn = !!this._radio;
        this._stopAll();
        this._sync();
        if (wasOn)
            this._notify('AirDrop is off', 'Wi-Fi is back.', {transient: true});
    }

    // ---- receiving -------------------------------------------------------------------
    async startReceiving() {
        if (this._receiving)
            return;
        this._receiving = true;
        this._sync();
        try {
            await this._radioUp();
        } catch (e) {
            this._receiving = false;
            this._sync();
            this._notify('AirDrop could not start', e.message);
            return;
        }
        if (!this._radio || !this._receiving)
            return;
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir();
        let proc;
        try {
            proc = spawn(['owly', 'receive', '--name', deviceName(), '--dir', dir],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._receiving = false;
            this._stopAll();
            this._sync();
            this._notify('AirDrop could not start', e.message);
            return;
        }
        this._receiver = proc;
        this._stdin = proc.get_stdin_pipe();
        let request = null;
        let showTimer = 0;
        const show = () => {
            showTimer = 0;
            const r = request;
            request = null;
            if (r)
                this._ask(r);
        };
        readLines(proc.get_stderr_pipe(), line => {
            const m = line.match(/^(".*") \((".*")\) wants to send:$/);
            if (m) {
                request = {from: unquote(m[1]), items: []};
            } else if (request && /^ {2}/.test(line)) {
                const item = line.trim().match(/^(".*?")(?: (\S+))?(?: (\d+) bytes)?$/);
                request.items.push(item ? unquote(item[1]) : line.trim());
            } else if (/^transfer failed: /.test(line)) {
                this._notify('AirDrop transfer failed', line.replace(/^transfer failed: /, ''));
            } else if (/request was withdrawn/.test(line)) {
                this._askNotification?.destroy();
            }
            // The "accept? [y/N]" prompt has no newline: show the question once the list stops.
            if (request) {
                if (showTimer)
                    GLib.source_remove(showTimer);
                showTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { show(); return GLib.SOURCE_REMOVE; });
            }
        });
        readLines(proc.get_stdout_pipe(), line => this._received(dir, line));
        this._notify('AirDrop is on', `Nearby iPhones see “${deviceName()}”. Files go to Downloads. ` +
            `Wi-Fi is paused; AirDrop turns off by itself in ${ON_MINUTES} minutes.`, {transient: true});
        proc.wait_async(null, () => {
            if (this._receiver === proc) {
                this._receiver = null;
                this._receiving = false;
                this._sync();
            }
        });
        this._sync();
    }

    _stopReceiver() {
        this._askNotification?.destroy();
        this._receiving = false;
        if (this._receiver) {
            const r = this._receiver;
            this._receiver = null;
            try { r.send_signal(SIGINT); } catch {}
        }
    }

    _answer(yes) {
        if (!this._stdin)
            return;
        const bytes = new TextEncoder().encode(yes ? 'y\n' : 'n\n');
        this._stdin.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try { s.write_bytes_finish(res); } catch (e) { log(`answer failed: ${e.message}`); }
        });
    }

    _ask(r) {
        const what = r.items.length === 1 ? r.items[0]
            : r.items.length ? `${r.items.length} items: ${r.items.slice(0, 3).join(', ')}${r.items.length > 3 ? '…' : ''}`
                : 'something';
        let answered = false;
        const answer = yes => {
            if (answered)
                return;
            answered = true;
            this._answer(yes);
        };
        const n = this._notify(`${r.from} wants to send you ${what}`, 'Accept within 15 seconds.', {
            urgency: MessageTray.Urgency.CRITICAL,
            actions: [['Decline', () => answer(false)], ['Accept', () => answer(true)]],
        });
        this._askNotification = n;
        this._cancelDone();
        n.connect('destroy', () => {
            if (this._askNotification === n)
                this._askNotification = null;
        });
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ASK_SECONDS, () => {
            if (!answered)
                n.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _received(dir, line) {
        if (!line)
            return;
        this._scheduleDone();
        if (line.startsWith('"')) {             // a link (Owly never opens it by itself)
            const url = unquote(line);
            this._notify('Link received', url, {actions: [['Open link', () => Gio.AppInfo.launch_default_for_uri(url, null)]]});
            return;
        }
        const file = Gio.File.new_for_path(line);
        this._notify('File received', `${file.get_basename()} is in Downloads.`, {
            actions: [
                ['Show in Files', () => this._showInFiles(file)],
                ['Open', () => Gio.AppInfo.launch_default_for_uri(file.get_uri(), null)],
            ],
        });
    }

    _showInFiles(file) {
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // ---- sending ---------------------------------------------------------------------
    chooseAndSend() {
        let proc;
        try {
            proc = spawn(['zenity', '--file-selection', '--multiple', '--separator=\n', '--title=Send with AirDrop'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._notify('AirDrop', `Can't open a file picker: ${e.message}`);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [, out] = p.communicate_utf8_finish(res);
            const paths = (out ?? '').split('\n').filter(Boolean);
            if (paths.length)
                this.sendFiles(paths);
        });
    }

    async sendFiles(paths) {
        paths = paths.filter(p => GLib.file_test(p, GLib.FileTest.EXISTS));
        if (!paths.length)
            return;
        this._sending++;
        const searching = this._notify('Looking for nearby iPhones…',
            'On the iPhone, set AirDrop to “Everyone for 10 minutes”. Wi-Fi pauses meanwhile.', {transient: true});
        try {
            await this._radioUp();
            const devices = await this._browse();
            searching.destroy();
            if (!devices.length) {
                this._notify('No iPhones found', 'Open AirDrop on the iPhone, set it to “Everyone for 10 minutes”, and try again.');
                return;
            }
            const to = await this._pick(devices, paths);
            if (to)
                await this._send(to, paths);
        } catch (e) {
            searching.destroy();
            this._notify('AirDrop could not send', e.message);
        } finally {
            this._sending--;
            // Started just for sending: give Wi-Fi back right away.
            if (!this._receiving && !this._sending)
                this.stop();
        }
    }

    _browse() {
        return new Promise((resolve, reject) => {
            const proc = spawn(['owly', 'browse', '--name', deviceName(), '--seconds', String(BROWSE_SECONDS)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    const seen = new Set();
                    const devices = [];
                    for (const line of (out ?? '').split('\n')) {
                        const m = line.match(/^\S+\s+(".*")\s+\(/);
                        const name = m && unquote(m[1]);
                        if (name && !seen.has(name)) {
                            seen.add(name);
                            devices.push(name);
                        }
                    }
                    resolve(devices);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _pick(devices, paths) {
        return new Promise(resolve => {
            const dialog = new ModalDialog.ModalDialog();
            this._dialog = dialog;
            const what = paths.length === 1 ? GLib.path_get_basename(paths[0]) : `${paths.length} files`;
            dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
                title: `Send ${what} with AirDrop`,
                description: 'Pick a nearby device:',
            }));
            const list = new St.BoxLayout({vertical: true, style_class: 'airdrop-devices', x_expand: true});
            let done = false;
            const finish = value => {
                if (done)
                    return;
                done = true;
                dialog.close();
                this._dialog = null;
                resolve(value);
            };
            for (const name of devices.slice(0, 8)) {
                const b = new St.Button({label: name, style_class: 'airdrop-device', x_expand: true, can_focus: true});
                b.connect('clicked', () => finish(name));
                list.add_child(b);
            }
            dialog.contentLayout.add_child(list);
            dialog.setButtons([{label: 'Cancel', action: () => finish(null), key: Clutter.KEY_Escape}]);
            dialog.connect('closed', () => finish(null));
            dialog.open();
        });
    }

    _send(to, paths) {
        return new Promise(resolve => {
            const proc = spawn(['owly', 'send', '--name', deviceName(), '--to', to, ...paths],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const status = this._notify(`Sending to ${to}…`, 'Waiting for them to accept.');
            readLines(proc.get_stderr_pipe(), line => {
                if (line === 'accepted')
                    status.body = 'Accepted, sending…';
                const m = line.match(/(\d+) \/ (\d+) bytes/);
                if (m)
                    status.body = `Sending… ${Math.round(100 * m[1] / Math.max(1, m[2]))}%`;
            });
            let result = '';
            readLines(proc.get_stdout_pipe(), line => { result = line; });
            proc.wait_async(null, () => {
                status.destroy();
                if (result === 'delivered')
                    this._notify(`Sent to ${to}`, paths.length === 1 ? GLib.path_get_basename(paths[0]) : `${paths.length} files`, {transient: true});
                else if (result === 'declined')
                    this._notify(`${to} declined`, 'Nothing was sent.');
                else
                    this._notify(`Couldn't send to ${to}`, result.replace(/^failed: /, '') || 'The transfer did not finish.');
                resolve();
            });
        });
    }
}
