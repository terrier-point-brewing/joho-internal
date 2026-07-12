import { describe, it, expect } from 'vitest';
import {
  NC_STATE_RATE,
  NC_COUNTY_TIERS,
  NC_COUNTIES,
  RATE_LINES,
  RATE_BY_LINE,
  countyRateLine,
  transitRateLine,
} from './rates';

describe('NC DOR Statutory Rates', () => {
  it('should export the correct state rate', () => {
    expect(NC_STATE_RATE).toBe(0.0475);
  });

  it('should export the rate lines 4-12', () => {
    expect(RATE_LINES).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  describe('RATE_BY_LINE', () => {
    it('maps each rate line to its statutory rate', () => {
      expect(RATE_BY_LINE).toEqual({
        '4': 0.0475,
        '5': 0.03,
        '6': 0.0475,
        '7': 0.0475,
        '8': 0.02,
        '9': 0.02,
        '10': 0.0225,
        '11': 0.005,
        '12': 0.0025,
      });
    });

    it('has an entry for every rate line', () => {
      for (const n of RATE_LINES) {
        expect(RATE_BY_LINE[String(n) as keyof typeof RATE_BY_LINE]).toBeTypeOf('number');
      }
    });

    it('line 4 equals the state rate; county lines 9-12 mirror the county tiers', () => {
      expect(RATE_BY_LINE['4']).toBe(NC_STATE_RATE);
      expect(RATE_BY_LINE['9']).toBe(NC_COUNTY_TIERS['WAKE'].local);
      expect(RATE_BY_LINE['10']).toBe(NC_COUNTY_TIERS['DURHAM'].local);
      expect(RATE_BY_LINE['11']).toBe(NC_COUNTY_TIERS['WAKE'].transit);
    });
  });

  describe('NC_COUNTY_TIERS', () => {
    it('should have Wake with special tier (2% local + 0.5% transit)', () => {
      expect(NC_COUNTY_TIERS['WAKE']).toEqual({
        local: 0.02,
        transit: 0.005,
      });
    });

    it('should have Mecklenburg with special tier (2% local + 0.5% transit)', () => {
      expect(NC_COUNTY_TIERS['MECKLENBURG']).toEqual({
        local: 0.02,
        transit: 0.005,
      });
    });

    it('should have Durham with special tier (2.25% local + 0.5% transit)', () => {
      expect(NC_COUNTY_TIERS['DURHAM']).toEqual({
        local: 0.0225,
        transit: 0.005,
      });
    });

    it('should have Orange with special tier (2.25% local + 0.5% transit)', () => {
      expect(NC_COUNTY_TIERS['ORANGE']).toEqual({
        local: 0.0225,
        transit: 0.005,
      });
    });

    it('should have Alamance with default tier (2% local)', () => {
      expect(NC_COUNTY_TIERS['ALAMANCE']).toEqual({
        local: 0.02,
        transit: 0,
      });
    });

    it('should have Alexander with 2.25% local (no transit)', () => {
      expect(NC_COUNTY_TIERS['ALEXANDER']).toEqual({
        local: 0.0225,
        transit: 0,
      });
    });

    it('should have New Hanover with 2.25% local (no transit)', () => {
      expect(NC_COUNTY_TIERS['NEW_HANOVER']).toEqual({
        local: 0.0225,
        transit: 0,
      });
    });

    it('should have 100 counties total', () => {
      expect(Object.keys(NC_COUNTY_TIERS).length).toBe(100);
    });
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

    it('every county code should exist in NC_COUNTY_TIERS', () => {
      for (const county of NC_COUNTIES) {
        expect(NC_COUNTY_TIERS[county.code]).toBeDefined();
        expect(NC_COUNTY_TIERS[county.code]).toHaveProperty('local');
        expect(NC_COUNTY_TIERS[county.code]).toHaveProperty('transit');
      }
    });
  });

  describe('countyRateLine', () => {
    it('should return "9" for 2% local rate', () => {
      expect(countyRateLine({ local: 0.02, transit: 0 })).toBe('9');
    });

    it('should return "9" for 2% local with transit', () => {
      expect(countyRateLine({ local: 0.02, transit: 0.005 })).toBe('9');
    });

    it('should return "10" for 2.25% local rate', () => {
      expect(countyRateLine({ local: 0.0225, transit: 0 })).toBe('10');
    });

    it('should return "10" for 2.25% local with transit', () => {
      expect(countyRateLine({ local: 0.0225, transit: 0.005 })).toBe('10');
    });
  });

  describe('transitRateLine', () => {
    it('should return null for no transit tax', () => {
      expect(transitRateLine({ local: 0.02, transit: 0 })).toBeNull();
    });

    it('should return null for 0 transit rate', () => {
      expect(transitRateLine({ local: 0.0225, transit: 0 })).toBeNull();
    });

    it('should return "11" for 0.5% transit rate', () => {
      expect(transitRateLine({ local: 0.02, transit: 0.005 })).toBe('11');
    });

    it('should return "11" for 0.005 transit rate', () => {
      expect(transitRateLine({ local: 0.0225, transit: 0.005 })).toBe('11');
    });

    it('should return "12" for 0.25% transit rate', () => {
      expect(transitRateLine({ local: 0.02, transit: 0.0025 })).toBe('12');
    });

    it('should return "12" for 0.0025 transit rate', () => {
      expect(transitRateLine({ local: 0.0225, transit: 0.0025 })).toBe('12');
    });
  });

  describe('Tier distribution', () => {
    it('should have 2 counties with Wake/Mecklenburg tier', () => {
      const wakeMeckTier = { local: 0.02, transit: 0.005 };
      const count = Object.values(NC_COUNTY_TIERS).filter(
        (tier) => tier.local === wakeMeckTier.local && tier.transit === wakeMeckTier.transit
      ).length;
      expect(count).toBe(2);
    });

    it('should have 2 counties with Durham/Orange tier', () => {
      const durhamOrangeTier = { local: 0.0225, transit: 0.005 };
      const count = Object.values(NC_COUNTY_TIERS).filter(
        (tier) => tier.local === durhamOrangeTier.local && tier.transit === durhamOrangeTier.transit
      ).length;
      expect(count).toBe(2);
    });

    it('should have 46 counties with 2.25% local only', () => {
      const tier225NoTransit = { local: 0.0225, transit: 0 };
      const count = Object.values(NC_COUNTY_TIERS).filter(
        (tier) => tier.local === tier225NoTransit.local && tier.transit === tier225NoTransit.transit
      ).length;
      expect(count).toBe(46);
    });

    it('should have 50 counties with 2% local only (default)', () => {
      const tier200NoTransit = { local: 0.02, transit: 0 };
      const count = Object.values(NC_COUNTY_TIERS).filter(
        (tier) => tier.local === tier200NoTransit.local && tier.transit === tier200NoTransit.transit
      ).length;
      expect(count).toBe(50);
    });
  });
});
