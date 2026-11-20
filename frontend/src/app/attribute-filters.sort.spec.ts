import { compareMissingLast } from './attribute-filters';

describe('compareMissingLast', () => {
  const rows = [NaN, 3, null, 1, '', 'nan', 2, undefined, 'N/A'];
  const sorted = (asc: boolean) => [...rows].sort((a, b) => compareMissingLast(a, b, asc));

  it('puts numbers first and missing values last, ascending', () => {
    expect(sorted(true).slice(0, 3)).toEqual([1, 2, 3]);
    expect(sorted(true).slice(3).every(v => !(typeof v === 'number' && v === v))).toBeTrue();
  });

  it('keeps missing values last when descending', () => {
    expect(sorted(false).slice(0, 3)).toEqual([3, 2, 1]);
  });

  it('sorts text numeric-aware and keeps empty strings last', () => {
    const t = ['b10', '', 'b2', 'a'].sort((x, y) => compareMissingLast(x, y, true));
    expect(t).toEqual(['a', 'b2', 'b10', '']);
    const d = ['b10', '', 'b2', 'a'].sort((x, y) => compareMissingLast(x, y, false));
    expect(d).toEqual(['b10', 'b2', 'a', '']);
  });
});
