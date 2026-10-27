// Test driver for AirDrop's device search in a throwaway headless shell (tests/shell/run.sh).
// Writes results.txt to $AIRDROP_OUT, then quits the shell.
import GLib from 'gi://GLib';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('AIRDROP_OUT');
const FAKE = GLib.getenv('AIRDROP_FAKE');
const lines = [];
const out = s => {
    lines.push(s);
    GLib.file_set_contents(`${OUT}/results.txt`, lines.join('\n') + '\n');
};
const check = (name, ok, extra = '') => out(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const now = () => GLib.get_monotonic_time() / 1e6;

function owlyLog() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${FAKE}/owly.log`)[1]);
    } catch {
        return '';
    }
}

function pickerNames(dialog) {
    const list = dialog.contentLayout.get_children().find(c => c.has_style_class_name?.('airdrop-devices'));
    return list ? list.get_children().map(b => b.label) : [];
}

function notificationTitles(ext) {
    return ext._source?.notifications.map(n => n.title) ?? [];
}

// Starts a send with the fake owly answering as `scenario`; resolves when the picker opens
// (with the names in it and the time it took) or when the send gives up. With `pick`, picks
// the first device and lets the send run (calling `during` while it does) instead of cancelling.
async function search(ext, scenario, file, {pick = false, during = null} = {}) {
    GLib.file_set_contents(`${FAKE}/scenario`, scenario);
    const t0 = now();
    const done = ext.sendFiles([file]);
    let finished = false;
    done.then(() => { finished = true; });
    while (!ext._dialog && !finished && now() - t0 < 30)
        await sleep(100);
    const result = {secs: now() - t0, names: ext._dialog ? pickerNames(ext._dialog) : null};
    if (pick && ext._dialog) {
        const list = ext._dialog.contentLayout.get_children().find(c => c.has_style_class_name?.('airdrop-devices'));
        list.get_children()[0].emit('clicked', 1);
        await during?.();
    }
    ext._dialog?.close();
    await done;
    await sleep(300);
    return result;
}

async function run() {
    let ext;
    for (let i = 0; i < 100 && !(ext = Main.extensionManager.lookup('airdrop@aimanelahssini')?.stateObj); i++)
        await sleep(100);
    if (!ext) {
        check('airdrop extension loaded', false);
        return;
    }
    if (Main.overview.visible)
        Main.overview.hide();
    // Record every notification AirDrop shows.
    const shown = [];
    const notify = ext._notify.bind(ext);
    ext._notify = (...args) => {
        const n = notify(...args);
        shown.push(n);
        return n;
    };
    const file = `${FAKE}/photo.jpg`;
    GLib.file_set_contents(file, 'x');

    // An iPhone that takes 9 s to answer (the old 6 s search missed it).
    let r = await search(ext, 'slow', file);
    check('slow iPhone shows up in the picker', JSON.stringify(r.names) === JSON.stringify(["Sam's iPhone"]),
        `names=${JSON.stringify(r.names)}`);
    check('picker opens soon after it answers, not at the end', r.secs > 9 && r.secs < 12.5, `t=${r.secs.toFixed(1)}s`);
    check('search stopped once the list was shown', /browse slow stopped/.test(owlyLog()) &&
        !/browse slow ran out/.test(owlyLog()));
    check('search asks owly for 15 s', /browse slow start seconds=15/.test(owlyLog()));

    // Two devices a second apart: both listed; one 3 s after the first is left out.
    r = await search(ext, 'two', file);
    check('devices answering within the grace are listed', JSON.stringify(r.names) === JSON.stringify(["Sam's iPhone", 'iPad']),
        `names=${JSON.stringify(r.names)}`);
    check('two-device picker opens about 1.5 s after the first', r.secs > 4 && r.secs < 6.5, `t=${r.secs.toFixed(1)}s`);

    // A whole send, with its progress banner closed halfway (as when it's swiped away).
    let status = null;
    await search(ext, 'two', file, {pick: true, during: async () => {
        await sleep(1500);
        status = shown.find(n => n.title.startsWith('Sending to'));
        status?.destroy();
    }});
    check('progress banner stays up (critical)', status?.urgency === MessageTray.Urgency.CRITICAL);
    check('send finishes after the banner was closed', shown.some(n => n.title === "Sent to Sam's iPhone"),
        JSON.stringify(shown.map(n => n.title)));

    // Nobody answers: no picker, "No iPhones found" after the whole 15 s.
    r = await search(ext, 'none', file);
    check('nobody: no picker', r.names === null);
    check('nobody: gives up after 15 s', r.secs > 14.5 && r.secs < 17.5, `t=${r.secs.toFixed(1)}s`);
    check('nobody: tells the user', notificationTitles(ext).includes('No iPhones found'),
        JSON.stringify(notificationTitles(ext)));
    const kept = shown.filter(n => !n.isTransient).map(n => n.title);
    check('every notification is transient (never kept in the list)', shown.length > 3 && !kept.length,
        `${shown.length} shown, kept: ${JSON.stringify(kept)}`);

    // Back-to-back sends share one radio session; it goes down 30 s after the last one.
    const ups = (owlyLog().match(/radio up/g) ?? []).length;
    check('back-to-back sends reuse the radio', ups === 1 && !!ext._radio, `radio started ${ups}x`);
    await sleep(25000);
    check('radio still up 25 s after the last send', !!ext._radio && !/radio down/.test(owlyLog()));
    await sleep(7000);
    check('radio off 30 s after the last send', !ext._radio && /radio down/.test(owlyLog()));
}

export default class AirDropTest extends Extension {
    enable() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            run().catch(e => out(`FAIL driver crashed: ${e}\n${e.stack}`)).finally(async () => {
                await sleep(500);
                global.context.terminate();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}
}
