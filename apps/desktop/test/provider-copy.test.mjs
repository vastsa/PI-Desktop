import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { copyProviderConfiguration } = await import('../src/components/settings/provider-copy.ts');
const source = () => ({
  id: 'original', name: 'Example', authKind: 'api_key_and_base_url',
  baseUrl: 'https://api.example.test/v1', apiStyle: 'responses',
  hasSecret: true, secretRef: 'secret:original', secretValue: 'never-copy',
  headers: { 'X-Custom-Token': 'never-copy', 'User-Agent': 'custom' },
  oauthAccountLabel: 'private-account', unknown: 'never-copy',
  models: [{ id: 'model', alias: 'Fast', contextWindow: 32000, maxTokens: 4000,
    thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'high',
    supportsImages: true, supportsDocuments: null, availableForSubagents: true,
    contextWindowSource: 'catalog', maxTokensSource: 'user',
    secretValue: 'never-copy' }],
});
test('copy drafts carry only editable non-credential fields, with independent models', () => {
  const original=source(); const before=structuredClone(original);
  const copy=copyProviderConfiguration(original, 'Example (copy)');
  assert.deepEqual(Object.keys(copy).sort(), ['apiStyle','baseUrl','models','name']);
  assert.equal(copy.apiStyle, 'responses');
  assert.equal(copy.baseUrl, original.baseUrl);
  assert.equal(copy.models[0].alias, 'Fast');
  assert.equal(copy.models[0].supportsImages, true);
  assert.equal(copy.models[0].supportsDocuments, null);
  assert.equal(copy.models[0].contextWindowSource, 'catalog');
  assert.equal(copy.models[0].maxTokensSource, 'user');
  assert.equal(copy.models[0].availableForSubagents, true);
  assert.ok(!JSON.stringify(copy).includes('never-copy'));
  copy.name='Changed'; copy.apiStyle='anthropic_messages';
  copy.models[0].alias='Changed'; copy.models[0].thinkingLevels.push('low');
  copy.models.push({...copy.models[0],id:'another'});
  assert.deepEqual(original,before);
});
test('each new copy has its own model settings and no stored-provider identity', () => {
  const original=source();
  const a=copyProviderConfiguration(original,'A'); const b=copyProviderConfiguration(original,'B');
  a.models[0].thinkingLevels.length=0;
  assert.deepEqual(b.models[0].thinkingLevels,['off','high']);
  assert.equal(a.id,undefined); assert.equal(a.hasSecret,undefined); assert.equal(a.headers,undefined);
});
test('credential-bearing and invalid endpoint URLs are not copied', () => {
  for(const url of ['https://user:password@example.test/v1','https://example.test/?key=secret','https://example.test/#secret','not-url','file:///private']) {
    assert.equal(copyProviderConfiguration({...source(),baseUrl:url},'Copy').baseUrl,'');
  }
});
test('vendor account logins cannot become copied API-key services', () => {
  assert.throws(()=>copyProviderConfiguration({...source(),authKind:'oauth'},'Copy'),/cannot be copied/);
});

test('named services retain their effective protocol when legacy apiStyle is absent', () => {
  const copy=copyProviderConfiguration({...source(),vendorKey:'anthropic',baseUrl:'https://api.anthropic.com',apiStyle:undefined},'Copy');
  assert.equal(copy.apiStyle,'anthropic_messages');
});

test('explicit protocols take precedence over matching endpoint presets', () => {
  for (const apiStyle of ['chat_completions', 'responses', 'opencode_go']) {
    const copy=copyProviderConfiguration({...source(),vendorKey:'custom',baseUrl:'https://api.openai.com/v1',apiStyle},'Copy');
    assert.equal(copy.apiStyle,apiStyle);
  }
});
