import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/shared/domain/errors';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and serializes with fixed scale as %p', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  it.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' '],
    ['1.005'],
    ['10.123'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1.'],
    ['.50'],
    ['1,00'],
    [' 1.00'],
    ['1000000000000000000.00'],
  ])('rejects invalid amount %p', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  it('rejects non-string amounts (numbers are never accepted)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each([['brl'], ['BR'], ['BRLX'], [''], ['12A']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('is exact where floats are not (0.1 + 0.2)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  it('never rounds: input with more than 2 decimals is rejected instead', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
  });

  it('adds, subtracts and negates returning new instances', () => {
    const a = brl('100.00');
    const b = brl('80.00');
    expect(a.subtract(b).amount).toBe('20.00');
    expect(b.subtract(a).amount).toBe('-20.00');
    expect(a.negate().amount).toBe('-100.00');
    expect(a.amount).toBe('100.00'); // immutable
  });

  it('handles large values without precision loss', () => {
    const big = brl('999999999999999999.99');
    expect(big.add(brl('0.01')).amount).toBe('1000000000000000000.00');
  });

  it('compares values', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  it('equals is false across currencies', () => {
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  it.each([
    ['add', () => brl('1.00').add(usd)],
    ['subtract', () => brl('1.00').subtract(usd)],
    ['isLessThan', () => brl('1.00').isLessThan(usd)],
  ])('%s throws CurrencyMismatchError', (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });
});
