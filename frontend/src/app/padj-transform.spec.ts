import { PADJ_FLOOR, isPadjColumn, padjToNegLog10 } from './padj-transform';

describe('padj-transform', () => {
  it('identifies padj columns by name', () => {
    expect(isPadjColumn('pathway_activity_padj_mlm')).toBeTrue();
    expect(isPadjColumn('tf_activity_padj_ulm')).toBeTrue();
    expect(isPadjColumn('cell_comp_tf_activity_padj_ulm')).toBeTrue();
    expect(isPadjColumn('moranI_padj')).toBeTrue();
    expect(isPadjColumn('ligand_receptor_p_value')).toBeTrue();
    expect(isPadjColumn('tf_activity_score_ulm')).toBeFalse();
    expect(isPadjColumn(null)).toBeFalse();
  });

  it('computes -log10 with a 1e-300 floor and keeps missing values missing', () => {
    expect(padjToNegLog10(1)).toBeCloseTo(0);
    expect(padjToNegLog10(1e-15)).toBeCloseTo(15);
    expect(padjToNegLog10(0)).toBeCloseTo(-Math.log10(PADJ_FLOOR));
    expect(padjToNegLog10('0.01')).toBeCloseTo(2);
    expect(padjToNegLog10(NaN)).toBeNaN();
    expect(padjToNegLog10(null)).toBeNaN();
    expect(padjToNegLog10(undefined)).toBeNaN();
  });
});
