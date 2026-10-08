import type { AgentSpawnInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const aufruf = (teil: Pick<AgentSpawnInput, 'prompt' | 'description' | 'subagentType' | 'model'>): AgentSpawnInput => ({
  tool_use_id: 'toolu_test',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...teil,
})


test('Explore ohne Modell läuft auf Haiku, eigenes Modell bleibt, general-purpose ohne Modell wird abgelehnt', async ($, on) => {
  const gesehen: Array<string | undefined> = []
  on('agent.spawn', (_$, e) => {
    gesehen.push(e.model)
    return { model: e.model ?? 'claude-opus-5-5', agentId: `a${gesehen.length}` }
  })
  await $.agent.spawn(aufruf({ prompt: 'Suche X', description: 'Suche', subagentType: 'Explore' }))
  await $.agent.spawn(aufruf({ prompt: 'Suche Y', description: 'Suche', subagentType: 'Explore', model: 'sonnet' }))
  await $.agent.spawn(aufruf({ prompt: 'Baue Z', description: 'Bauen', subagentType: 'general-purpose' }))
  expect(gesehen).toEqual(['haiku', 'sonnet'])
})

test('abschaltbar über die Einstellung', { options: { explore_auf_haiku: false } }, async ($, on) => {
  const gesehen: Array<string | undefined> = []
  on('agent.spawn', (_$, e) => {
    gesehen.push(e.model)
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  await $.agent.spawn(aufruf({ prompt: 'Suche X', description: 'Suche', subagentType: 'Explore' }))
  expect(gesehen).toEqual([undefined])
})
