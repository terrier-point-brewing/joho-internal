// Square reporting category IDs, keyed by their business meaning.
// Entries come in pairs where two locations have separate but equivalent categories.

export const CATEGORY_IDS = {
  DRAFT: new Set([
    "567KQPEBRBZHG7ATHQFRCRWZ", // Draft (main)
    "DCPYMNVDYNX4JAFI22DMVKLN", // Draft (Holly Springs)
  ]),
  KEGS: new Set([
    "FXHTXXAICGRPMGJAHGJZ34MY", // Kegs (main)
    "L47I4EF3LKJOSWUH47C5JNDA", // Kegs (Holly Springs)
  ]),
  CANS: new Set([
    "Q5BMUOAOCBOUS4JNDRAAXA4Q", // Cans (main)
    "TSRMBVP2CWAHLZO4DFTXAQ7Q", // Cans (Holly Springs)
  ]),
  COCKTAILS: new Set([
    "IPD6T7FOCCZBXG2HOPOVFB4J", // Cocktails (main)
    "UE65PMYDYAA3GZVZZE2QXTEF", // Cocktails (Holly Springs)
  ]),
  BOURBON: new Set([
    "HN4WYDVIFBWTS6XZQVCS3PV7", // Bourbon (main)
    "J6KQFWSAHICHKE7VUFLCSK6O", // Bourbon (Holly Springs)
  ]),
  TEQUILA: new Set([
    "DMN6KPKKAPSD5ACKII4XL6MB", // Tequila (main)
    "SSZBQ7F3XLUMSJKOFETT7J3E", // Tequila (Holly Springs)
  ]),
  RUM: new Set([
    "ZDO2A6BY6436YKU2OYANKTOE", // Rum (main)
    "RAUBCOON66IN5TWMKAMC3SQQ", // Rum (Holly Springs)
  ]),
  VODKA: new Set([
    "JE4SAYBBE6XW2W6QKCJ2N3RT", // Vodka (main)
    "CNN2QQJUWZNXFRUATKNXUSA5", // Vodka (Holly Springs)
  ]),
  GIN: new Set([
    "A5M5IAD2IKGX56SQ3JV7JUTG", // Gin (main)
    "WK3DXHBWSDFMW6E3G3MEODRM", // Gin (Holly Springs)
  ]),
  WHISKEY: new Set([
    "BRCNBA7EQUJTERWY6DPCPATH", // Whiskey (main)
    "4Y35NEUUJ5G6NTRPIDY62NZH", // Whiskey (Holly Springs)
  ]),
  WINE: new Set(["LZTB6W2YCUEHXEBBMIGRJFTA"]),
  CIDER: new Set(["LF2BURFOKACF7PGNVNKDNBI4"]),
  SELTZER: new Set(["QXDCEF4UVD5GV4EJMEF4RH5V"]),
  NON_ALCOHOLIC: new Set(["SQU43MD34LLCGW4ELQ2HSPPD"]),
  SNACKS: new Set(["VS5QIJ7EH56OXJ3OOMNCJVHP"]),
  PREPARED: new Set(["YS27WNLY4BAGJDIS66WLBHQX"]),
  MERCHANDISE: new Set([
    "QDY242ULK5TF5GNWOSOZ2KG4", // Merchandise (main)
    "KX4N5F4WGSI7VMYUL3ZXJQVM", // Merch (Holly Springs)
  ]),
  TANK_FILLS: new Set(["6M5K5FSUDGPCMGIC7BOUDAK2"]),
  DEPOSITS: new Set(["3Y5UG43QKQ6DD2BCSVKECCQL"]),
} as const;

// Taproom Model report categories and which Square categories roll into each
export const TAPROOM_MODEL_CATEGORIES = [
  { id: "DRAFT_BEER",         label: "Draft Beer",           squareCats: [...CATEGORY_IDS.DRAFT] },
  { id: "LIQUOR",             label: "Liquor",               squareCats: [...CATEGORY_IDS.BOURBON, ...CATEGORY_IDS.TEQUILA, ...CATEGORY_IDS.RUM, ...CATEGORY_IDS.VODKA, ...CATEGORY_IDS.GIN, ...CATEGORY_IDS.WHISKEY] },
  { id: "WINE_CIDER_SELTZER", label: "Wine/Cider/Seltzers",  squareCats: [...CATEGORY_IDS.WINE, ...CATEGORY_IDS.CIDER, ...CATEGORY_IDS.SELTZER] },
  { id: "COCKTAILS",          label: "Cocktails",            squareCats: [...CATEGORY_IDS.COCKTAILS] },
  { id: "NA_SNACKS",          label: "NA/Snacks",            squareCats: [...CATEGORY_IDS.NON_ALCOHOLIC, ...CATEGORY_IDS.SNACKS, ...CATEGORY_IDS.PREPARED] },
  { id: "KEGS",               label: "Kegs",                 squareCats: [...CATEGORY_IDS.KEGS] },
  { id: "CANS",               label: "Cans",                 squareCats: [...CATEGORY_IDS.CANS] },
  { id: "MERCHANDISE",        label: "Merchandise",          squareCats: [...CATEGORY_IDS.MERCHANDISE] },
  { id: "CO2",                label: "CO2",                  squareCats: [...CATEGORY_IDS.TANK_FILLS] },
  { id: "DEPOSITS",           label: "Deposits",             squareCats: [...CATEGORY_IDS.DEPOSITS] },
] as const;

export type TaproomCategoryId = (typeof TAPROOM_MODEL_CATEGORIES)[number]["id"];
