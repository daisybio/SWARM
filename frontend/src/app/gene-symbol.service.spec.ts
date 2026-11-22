import { GeneSymbolService } from './gene-symbol.service';

describe('GeneSymbolService organism casing', () => {
  let s: GeneSymbolService;
  beforeEach(() => (s = new GeneSymbolService(null as any)));

  it('leaves lower-case names alone when the organism is unspecified', () => {
    expect(s.label('lamp5')).toBe('lamp5');
    s.setOrganism('rat');
    expect(s.label('lamp5')).toBe('lamp5');
  });

  it('upper-cases for human, capitalizes for mouse', () => {
    s.setOrganism('human');
    expect(s.label('al627309.1')).toBe('AL627309.1');
    expect(s.label('mir1302-2hg')).toBe('MIR1302-2HG');
    s.setOrganism('mouse');
    expect(s.label('lamp5')).toBe('Lamp5');
  });

  it('keeps mixed-case names, Ensembl ids and miRNA ids', () => {
    s.setOrganism('human');
    expect(s.label('TP53')).toBe('TP53');
    expect(s.label('hsa-mir-1253')).toBe('hsa-mir-1253');
    expect(s.label('ENSG00000141510')).toBe('ENSG00000141510');
  });
});
