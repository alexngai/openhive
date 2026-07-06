/**
 * The default idea-lab pack.
 *
 * This is the checked-in declaration the provisioner applies at boot. Edit
 * this file (and the referenced `roles/*.ts` prompts) to shape the lab — the
 * objectives are yours to replace, and the cadences below are the emergent
 * "round": ideator hourly at :00, skeptic at :20, synthesizer at :40, judge
 * every 6h at :00, dispatcher every 6h at :30. Offsets make the phases fall
 * in a natural order without any controller enforcing it.
 */

import { parseIdeaLabPack, type IdeaLabPack } from './types.js';
import { IDEATOR_PROMPT } from './roles/ideator.js';
import { SKEPTIC_PROMPT } from './roles/skeptic.js';
import { SYNTHESIZER_PROMPT } from './roles/synthesizer.js';
import { JUDGE_PROMPT } from './roles/judge.js';
import { DISPATCHER_PROMPT } from './roles/dispatcher.js';

export const DEFAULT_IDEA_LAB_PACK: IdeaLabPack = parseIdeaLabPack({
  version: 1,
  graph: {
    name: 'idea-lab/graph',
    description: 'Idea-lab OpenTasks graph — ideas and pinned objectives.',
  },
  ledger: {
    name: 'idea-lab/ledger',
    description: 'Idea-lab ledger — tried / killed / shipped ideas and distilled lessons.',
  },
  // Replace these with your real seed objectives. They are pinned north-stars
  // the anchored tier must advance; each becomes a spec in the lab graph.
  objectives: [
    {
      key: 'example-objective',
      title: 'Example objective — replace me',
      content:
        'Describe a north-star the lab should pursue: the goal, why it matters, ' +
        'and what a good outcome looks like. Anchored ideas are judged on how ' +
        'well they advance an objective like this one.',
      priority: 3,
    },
  ],
  roles: [
    { key: 'ideator', cron: '0 * * * *', prompt: IDEATOR_PROMPT },
    { key: 'skeptic', cron: '20 * * * *', prompt: SKEPTIC_PROMPT },
    { key: 'synthesizer', cron: '40 * * * *', prompt: SYNTHESIZER_PROMPT },
    { key: 'judge', cron: '0 */6 * * *', prompt: JUDGE_PROMPT },
    { key: 'dispatcher', cron: '30 */6 * * *', prompt: DISPATCHER_PROMPT },
  ],
});
