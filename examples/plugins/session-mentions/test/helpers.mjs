export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const user = (content, fields = {}) => ({ role: 'user', content, ...fields });
export const assistant = (content, fields = {}) => ({ role: 'assistant', content, status: 'completed', ...fields });
export const source = (id, pairs, fields = {}) => ({
  id, title: id === A ? 'Alpha' : 'Beta',
  messages: pairs.flatMap(([q, a], i) => [
    user(q, { id: `${id}-u${i}` }), assistant(a, { id: `${id}-a${i}` }),
  ]), ...fields,
});
export const page = (id, messages, fields = {}) => ({
  id, title: id === A ? 'Alpha' : 'Beta', messages,
  messageStart: 0, messageEnd: messages.length, hasMoreBefore: false, ...fields,
});
export const NO_IO = () => { throw new Error('Unexpected I/O'); };
