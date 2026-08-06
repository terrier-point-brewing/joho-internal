import { describe, it, expect } from 'vitest';
import { NC_COUNTIES, RATE_LINES, countyRateLine, transitRateLine } from './rates';

describe('NC DOR Rate Schedule (structural)', () => {
  it('should export the rate lines 4-12, less the merged line 7', () => {
    // Line 7 (Mfg. Homes) is reported inside Line 6 as one combined
    // "Modular & Mfg. Homes" line — it carries no field triple of its own.
    expect(RATE_LINES).toEqual([4, 5, 6, 8, 9, 10, 11, 12]);
  });

  describe('NC_COUNTIES', () => {
    it('should have exactly 100 counties', () => {
      expect(NC_COUNTIES.length).toBe(100);
    });

    it('should have Alamance as first county (ncCode 1)', () => {
      expect(NC_COUNTIES[0]).toEqual({
        code: 'ALAMANCE',
        name: 'Alamance',
        ncCode: 1,
      });
    });

    it('should have Yancey as last county (ncCode 100)', () => {
      expect(NC_COUNTIES[99]).toEqual({
        code: 'YANCEY',
        name: 'Yancey',
        ncCode: 100,
      });
    });

    it('should have Wake at position 91 (ncCode 92)', () => {
      const wake = NC_COUNTIES.find((c) => c.code === 'WAKE');
      expect(wake).toEqual({
        code: 'WAKE',
        name: 'Wake',
        ncCode: 92,
      });
    });

    it('should have New Hanover at position 64 (ncCode 65)', () => {
      const nh = NC_COUNTIES.find((c) => c.code === 'NEW_HANOVER');
      expect(nh).toEqual({
        code: 'NEW_HANOVER',
        name: 'New Hanover',
        ncCode: 65,
      });
    });

    it('should have county codes in uppercase with spaces replaced by underscores', () => {
      const newHanover = NC_COUNTIES.find((c) => c.ncCode === 65);
      expect(newHanover?.code).toBe('NEW_HANOVER');
    });

    it('every county should have a unique code', () => {
      const codes = new Set(NC_COUNTIES.map((c) => c.code));
      expect(codes.size).toBe(NC_COUNTIES.length);
    });
  });

  describe('countyRateLine', () => {
    it('should return "9" for a 2% local rate', () => {
      expect(countyRateLine(0.02)).toBe('9');
    });

    it('should return "10" for a 2.25% local rate', () => {
      expect(countyRateLine(0.0225)).toBe('10');
    });

    it('is independent of the transit rate (only the local rate is inspected)', () => {
      expect(countyRateLine(0.02)).toBe('9');
      expect(countyRateLine(0.0225)).toBe('10');
    });
  });

  describe('transitRateLine', () => {
    it('should return null for a 0 transit rate', () => {
      expect(transitRateLine(0)).toBeNull();
    });

    it('should return "11" for a 0.5% transit rate', () => {
      expect(transitRateLine(0.005)).toBe('11');
    });

    it('should return "12" for a 0.25% transit rate', () => {
      expect(transitRateLine(0.0025)).toBe('12');
    });

    it('returns null for an unrecognized transit rate', () => {
      expect(transitRateLine(0.01)).toBeNull();
    });
  });
});
