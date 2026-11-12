import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Wire/DTO format. `amount` is a decimal string with up to 2 decimals, e.g. "25.00". */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 100n;
// numeric(20,2) in PostgreSQL => at most 18 integer digits.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Stored as an integer count of minor units (bigint),
 * so there is no floating point anywhere. Every operation returns a new instance.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses an input contract value. Rejects NaN, Infinity, scientific notation,
   * empty strings, more than 2 decimals, signs and leading zeros. Never rounds.
   */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    const amount: unknown = props.amount;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${String(amount)}": expected a non-negative decimal string with at most ${SCALE} decimals`,
      );
    }
    const [integerPart = '0', fractionPart = ''] = amount.split('.');
    const minor = BigInt(integerPart) * FACTOR + BigInt(fractionPart.padEnd(SCALE, '0'));
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Fixed-scale decimal string, e.g. "25.00" or "-5.10". */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integer = (abs / FACTOR).toString();
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
    return currency;
  }
}
