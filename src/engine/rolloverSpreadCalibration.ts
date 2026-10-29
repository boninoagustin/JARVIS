// Independent clean spread references for the current Spotware DEMO broker.
// Measured from historical BID/ASK: 2026-10-12 and 2026-10-13, 13:00–14:00 UTC.
// Lower median of daily liquid-session medians; stale/crossed/rollover quotes excluded.
// Evidence: logs/rollover_safety/clean_spread_calibration.json and raw pages.
// Price units only. Recalibrate before using a different broker/account universe.
export const rolloverSpreadCalibration: Record<string, { cleanBaseline: number }> = {
    "AUDCAD": {
        "cleanBaseline": 4.0000000000040004e-05
    },
    "AUDJPY": {
        "cleanBaseline": 0.0040000000000048885
    },
    "AUDNZD": {
        "cleanBaseline": 0.00019999999999997797
    },
    "EUROPE50": {
        "cleanBaseline": 0.6999999999998181
    },
    "EURUSD": {
        "cleanBaseline": 1.0000000000065512e-05
    },
    "FRA40": {
        "cleanBaseline": 1.300000000000182
    },
    "GBPAUD": {
        "cleanBaseline": 5.999999999994898e-05
    },
    "GBPUSD": {
        "cleanBaseline": 1.0000000000065512e-05
    },
    "JP225": {
        "cleanBaseline": 3
    },
    "NL25": {
        "cleanBaseline": 0.6200000000001182
    },
    "NZDUSD": {
        "cleanBaseline": 1.0000000000065512e-05
    },
    "USDJPY": {
        "cleanBaseline": 0.001999999999981128
    },
    "USOIL": {
        "cleanBaseline": 0.04000000000000625
    },
    "XAUUSD": {
        "cleanBaseline": 0.0999999999994543
    },
    "XPTUSD": {
        "cleanBaseline": 9.220000000000027
    }
};
