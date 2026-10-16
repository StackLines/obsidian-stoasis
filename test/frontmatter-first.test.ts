import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { keepFrontmatterFirst } from '../src/sync/frontmatter-first';

const BLOCK = '---\nbrain-id: 5f0c2a9e-3b1d-4c7e-8a6f-0d2b4e6c8a1f\nbrain-schema: stoasis/2\n---\n';

/** A device's copy of a note, which keeps arriving frontmatter first, and a server copy with a higher client id. */
function setUp(text = 'Body.\n') {
	const device = new Y.Doc();
	device.clientID = 100;
	device.getText('content').insert(0, text);
	device.getText('content').observe(keepFrontmatterFirst);
	const server = new Y.Doc();
	server.clientID = 200;
	Y.applyUpdate(server, Y.encodeStateAsUpdate(device));
	/** What the server changes, from what it has now, as an update for the device. */
	const serverChange = (change: (text: Y.Text) => void) => {
		const before = Y.encodeStateVector(server);
		change(server.getText('content'));
		return Y.encodeStateAsUpdate(server, before);
	};
	return { device, server, serverChange, text: () => device.getText('content').toJSON() };
}

describe('keepFrontmatterFirst', () => {
	it("moves this device's text typed at the start after frontmatter inserted there at the same time", () => {
		const { device, serverChange, text } = setUp();
		const update = serverChange((t) => t.insert(0, BLOCK));
		device.getText('content').insert(0, 'Typed. ');
		Y.applyUpdate(device, update);
		expect(text()).toBe(`${BLOCK}Typed. Body.\n`);
	});

	it('moves nothing when the frontmatter already comes first', () => {
		const { device, serverChange, text } = setUp();
		const update = serverChange((t) => t.insert(0, BLOCK));
		device.getText('content').insert(3, ' typed');
		Y.applyUpdate(device, update);
		expect(text()).toBe(`${BLOCK}Bod typedy.\n`);
	});

	it("leaves another device's text before it to that device", () => {
		const { device, server, serverChange, text } = setUp();
		const other = new Y.Doc();
		other.clientID = 50;
		Y.applyUpdate(other, Y.encodeStateAsUpdate(server));
		other.getText('content').insert(0, 'Other. ');
		const block = serverChange((t) => t.insert(0, BLOCK));
		Y.applyUpdate(device, Y.encodeStateAsUpdate(other));
		Y.applyUpdate(device, block);
		expect(text()).toBe(`Other. ${BLOCK}Body.\n`);
	});

	it('moves nothing for text inserted at the start that is not a whole frontmatter block', () => {
		for (const insert of ['# Title\n', '---\nnot closed\n', '--- \nkey: v\n---\n']) {
			const { device, serverChange, text } = setUp();
			const update = serverChange((t) => t.insert(0, insert));
			device.getText('content').insert(0, 'Typed. ');
			Y.applyUpdate(device, update);
			expect(text()).toBe(`Typed. ${insert}Body.\n`);
		}
	});

	it('moves nothing for frontmatter inserted after other text', () => {
		const { device, serverChange, text } = setUp('Intro.\nBody.\n');
		const update = serverChange((t) => t.insert('Intro.\n'.length, BLOCK));
		device.getText('content').insert(0, 'Typed. ');
		Y.applyUpdate(device, update);
		expect(text()).toBe(`Typed. Intro.\n${BLOCK}Body.\n`);
	});

	it('moves it once: the move arriving back from the server changes nothing', () => {
		const { device, server, serverChange, text } = setUp();
		const update = serverChange((t) => t.insert(0, BLOCK));
		device.getText('content').insert(0, 'Typed. ');
		const before = Y.encodeStateVector(device);
		Y.applyUpdate(server, Y.encodeStateAsUpdate(device));
		Y.applyUpdate(device, update);
		Y.applyUpdate(server, Y.encodeStateAsUpdate(device, before));
		Y.applyUpdate(device, Y.encodeStateAsUpdate(server));
		expect(text()).toBe(`${BLOCK}Typed. Body.\n`);
		expect(server.getText('content').toJSON()).toBe(`${BLOCK}Typed. Body.\n`);
	});
});
