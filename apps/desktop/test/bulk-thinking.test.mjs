import assert from 'node:assert/strict';
import test from 'node:test';
import { DisclosureChoices, createDisclosureState } from '../src/lib/transcript-disclosure-choices.ts';
const thinking = (id) => JSON.stringify(['thinking', id]);

test('bulk expansion overrides old choices and reveals collapsed ancestors', () => {
  const store = new DisclosureChoices();
  store.set(thinking('a'), { open: false });
  store.set('turn', { open: false });
  store.setThinking(['a', 'history'], true);
  assert.equal(store.get(thinking('a')).open, true);
  assert.equal(store.get('turn', ['a']).open, true);
  assert.equal(store.get('unmounted-group', ['history']).open, true);
  assert.equal(store.get(thinking('future')), undefined);
  assert.equal(store.get('tool'), undefined);
});

test('manual changes after a batch win until the next batch', () => {
  const store = new DisclosureChoices();
  store.setThinking(['a'], true);
  store.set('turn', { open: false });
  store.set(thinking('a'), { open: false });
  assert.equal(store.get('turn', ['a']).open, false);
  assert.equal(store.get(thinking('a')).open, false);
  store.setThinking(['a'], true);
  assert.equal(store.get('turn', ['a']).open, true);
  assert.equal(store.get(thinking('a')).open, true);
});

test('collapse changes thinking leaves without closing ancestors or tools', () => {
  const store = new DisclosureChoices();
  store.set('tool', { open: true });
  store.setThinking(['a'], true);
  store.setThinking(['a'], false);
  assert.equal(store.get(thinking('a')).open, false);
  assert.equal(store.get('turn', ['a']).open, true);
  assert.equal(store.get('tool').open, true);
});

test('history remount and pane eviction preserve choices, other sessions remain independent', () => {
  const state = createDisclosureState();
  const first = new DisclosureChoices(state);
  first.setThinking(['old'], true);
  first.set('turn', { open: false });
  const remounted = new DisclosureChoices(state);
  assert.equal(remounted.get(thinking('old')).open, true);
  assert.equal(remounted.get('turn', ['old']).open, false);
  assert.equal(remounted.get('regrouped-history', ['old']).open, true);
  assert.equal(new DisclosureChoices().get(thinking('old')), undefined);
});

test('a batch publishes only after all affected choices are available', () => {
  const store = new DisclosureChoices();
  const observed = [];
  const off = store.subscribe('turn', () => observed.push([
    store.get(thinking('a')).open, store.get(thinking('b')).open,
  ]));
  store.setThinking(['a', 'b'], true);
  assert.deepEqual(observed, [[true, true]]);
  off();
  store.setThinking(['a', 'b'], false);
  assert.equal(observed.length, 1);
});
