import { DUPLICATES, SERVICES } from './registry';

it('every aws operation is defined once', () => {
  expect(DUPLICATES).toEqual([]);
});

it('every operation has a description and kebab-case parameters', () => {
  for (const [name, s] of SERVICES) {
    expect(s.desc, name).toBeTruthy();
    for (const op of s.ops.values()) {
      expect(op.desc, `${name} ${op.name}`).toBeTruthy();
      for (const p of op.params) expect(p.name, `${name} ${op.name}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  }
});
