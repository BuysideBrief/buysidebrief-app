const { isValidEmail } = require('../api/subscribe');

describe('isValidEmail', () => {
  test('accepts standard email', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
  });

  test('accepts subdomain email', () => {
    expect(isValidEmail('user@sub.domain.com')).toBe(true);
  });

  test('rejects single-char TLD', () => {
    expect(isValidEmail('test@t.c')).toBe(false);
  });

  test('rejects dot-leading domain', () => {
    expect(isValidEmail('test@.com')).toBe(false);
  });

  test('rejects missing local part', () => {
    expect(isValidEmail('@example.com')).toBe(false);
  });

  test('rejects missing domain', () => {
    expect(isValidEmail('test@')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });

  test('rejects email longer than 254 characters', () => {
    const longEmail = 'a'.repeat(243) + '@example.com'; // 255 chars
    expect(isValidEmail(longEmail)).toBe(false);
  });

  test('accepts email exactly 254 characters', () => {
    const email254 = 'a'.repeat(242) + '@example.com'; // 254 chars
    expect(isValidEmail(email254)).toBe(true);
  });
});
