import {
  assistantMessage,
  buildFrom,
  toolResultMessage,
  userMessage,
} from './fusion-canonical.js';

const messages = [
  userMessage('repeatable question'),
  assistantMessage([
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: 'visible' },
    { type: 'toolCall', id: 'c1', name: 'bash', arguments: { z: 1, a: 2 } },
  ]),
  toolResultMessage('c1', 'bash', [{ type: 'text', text: 'file listing' }]),
];

const built = buildFrom(messages, { source: 'tool', request: 'again' });
process.stdout.write(
  `${built.serialized}\n${built.input.conversation_projection.accounting.ledger_root_sha256}`,
);
