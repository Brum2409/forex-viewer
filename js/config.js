/* ============================================================
   CONFIGURATION
   ============================================================ */
const CFG = {
  REFRESH_SECS: 15 * 60,
  PAIRS: [
    // Majors
    { f:"EUR", t:"USD", fn:"Euro",             tn:"US Dollar",         ff:"🇪🇺", tf:"🇺🇸", cat:"Majors" },
    { f:"GBP", t:"USD", fn:"British Pound",    tn:"US Dollar",         ff:"🇬🇧", tf:"🇺🇸", cat:"Majors" },
    { f:"USD", t:"JPY", fn:"US Dollar",        tn:"Japanese Yen",      ff:"🇺🇸", tf:"🇯🇵", cat:"Majors" },
    { f:"USD", t:"CHF", fn:"US Dollar",        tn:"Swiss Franc",       ff:"🇺🇸", tf:"🇨🇭", cat:"Majors" },
    { f:"AUD", t:"USD", fn:"Australian Dollar",tn:"US Dollar",         ff:"🇦🇺", tf:"🇺🇸", cat:"Majors" },
    { f:"USD", t:"CAD", fn:"US Dollar",        tn:"Canadian Dollar",   ff:"🇺🇸", tf:"🇨🇦", cat:"Majors" },
    { f:"NZD", t:"USD", fn:"New Zealand Dollar",tn:"US Dollar",        ff:"🇳🇿", tf:"🇺🇸", cat:"Majors" },
    // Euro Crosses
    { f:"EUR", t:"GBP", fn:"Euro",             tn:"British Pound",     ff:"🇪🇺", tf:"🇬🇧", cat:"Euro Crosses" },
    { f:"EUR", t:"JPY", fn:"Euro",             tn:"Japanese Yen",      ff:"🇪🇺", tf:"🇯🇵", cat:"Euro Crosses" },
    { f:"EUR", t:"CHF", fn:"Euro",             tn:"Swiss Franc",       ff:"🇪🇺", tf:"🇨🇭", cat:"Euro Crosses" },
    { f:"EUR", t:"CAD", fn:"Euro",             tn:"Canadian Dollar",   ff:"🇪🇺", tf:"🇨🇦", cat:"Euro Crosses" },
    { f:"EUR", t:"AUD", fn:"Euro",             tn:"Australian Dollar", ff:"🇪🇺", tf:"🇦🇺", cat:"Euro Crosses" },
    // Sterling Crosses
    { f:"GBP", t:"JPY", fn:"British Pound",    tn:"Japanese Yen",      ff:"🇬🇧", tf:"🇯🇵", cat:"Sterling Crosses" },
    { f:"GBP", t:"CHF", fn:"British Pound",    tn:"Swiss Franc",       ff:"🇬🇧", tf:"🇨🇭", cat:"Sterling Crosses" },
    { f:"GBP", t:"AUD", fn:"British Pound",    tn:"Australian Dollar", ff:"🇬🇧", tf:"🇦🇺", cat:"Sterling Crosses" },
    { f:"GBP", t:"CAD", fn:"British Pound",    tn:"Canadian Dollar",   ff:"🇬🇧", tf:"🇨🇦", cat:"Sterling Crosses" },
    // Commodity / Pacific
    { f:"AUD", t:"JPY", fn:"Australian Dollar",tn:"Japanese Yen",      ff:"🇦🇺", tf:"🇯🇵", cat:"Commodity Pairs" },
    { f:"AUD", t:"NZD", fn:"Australian Dollar",tn:"New Zealand Dollar",ff:"🇦🇺", tf:"🇳🇿", cat:"Commodity Pairs" },
    { f:"AUD", t:"CAD", fn:"Australian Dollar",tn:"Canadian Dollar",   ff:"🇦🇺", tf:"🇨🇦", cat:"Commodity Pairs" },
    { f:"CAD", t:"JPY", fn:"Canadian Dollar",  tn:"Japanese Yen",      ff:"🇨🇦", tf:"🇯🇵", cat:"Commodity Pairs" },
    // Emerging
    { f:"USD", t:"CNY", fn:"US Dollar",        tn:"Chinese Yuan",      ff:"🇺🇸", tf:"🇨🇳", cat:"Emerging Markets" },
    { f:"USD", t:"INR", fn:"US Dollar",        tn:"Indian Rupee",      ff:"🇺🇸", tf:"🇮🇳", cat:"Emerging Markets" },
    { f:"USD", t:"MXN", fn:"US Dollar",        tn:"Mexican Peso",      ff:"🇺🇸", tf:"🇲🇽", cat:"Emerging Markets" },
    { f:"USD", t:"BRL", fn:"US Dollar",        tn:"Brazilian Real",    ff:"🇺🇸", tf:"🇧🇷", cat:"Emerging Markets" },
    { f:"USD", t:"SGD", fn:"US Dollar",        tn:"Singapore Dollar",  ff:"🇺🇸", tf:"🇸🇬", cat:"Emerging Markets" },
    { f:"USD", t:"HKD", fn:"US Dollar",        tn:"Hong Kong Dollar",  ff:"🇺🇸", tf:"🇭🇰", cat:"Emerging Markets" },
    { f:"USD", t:"NOK", fn:"US Dollar",        tn:"Norwegian Krone",   ff:"🇺🇸", tf:"🇳🇴", cat:"Emerging Markets" },
    { f:"USD", t:"SEK", fn:"US Dollar",        tn:"Swedish Krona",     ff:"🇺🇸", tf:"🇸🇪", cat:"Emerging Markets" },
  ],
};

/* ============================================================
   INTERVAL → YAHOO FINANCE MAPPING
   All intervals now use Yahoo Finance exclusively.
   2h and 4h share the 1h YF fetch and aggregate client-side.
   ============================================================ */
const INTERVAL_CONFIG = {
  "1m":  { yfInterval: "1m",  yfRange: "1d",   groupMins: 1     },
  "5m":  { yfInterval: "5m",  yfRange: "5d",   groupMins: 5     },
  "15m": { yfInterval: "15m", yfRange: "60d",  groupMins: 15    },
  "30m": { yfInterval: "30m", yfRange: "60d",  groupMins: 30    },
  "1h":  { yfInterval: "1h",  yfRange: "60d",  groupMins: 60    },
  "2h":  { yfInterval: "1h",  yfRange: "60d",  groupMins: 120   },
  "4h":  { yfInterval: "1h",  yfRange: "60d",  groupMins: 240   },
  "1D":  { yfInterval: "1d",  yfRange: "2y",   groupMins: 1440  },
  "1W":  { yfInterval: "1wk", yfRange: "10y",  groupMins: 10080 },
};

const INTERVAL_LABELS = {
  "1m":"1m", "5m":"5m", "15m":"15m", "30m":"30m",
  "1h":"1h", "2h":"2h", "4h":"4h", "1D":"1D", "1W":"1W",
};

// Cache TTL in ms per interval
const CACHE_TTL = {
  "1m":60_000, "5m":120_000, "15m":300_000, "30m":300_000,
  "1h":600_000, "2h":900_000, "4h":900_000, "1D":3_600_000, "1W":3_600_000,
};
