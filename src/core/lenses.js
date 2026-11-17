// Objektiv-Vorwissen (Priors) für den Solver.
// Alle Werte beziehen sich auf das EINGANGSSIGNAL des Projektors (z. B. 1920x1080),
// nicht auf das native Panel. throw = Abstand / Bildbreite.
//
// cyFrac: Lage der optischen Achse in Bildhöhen, gemessen von OBEN (0 = Oberkante, 1 = Unterkante).
//         Werte > 1 bedeuten: Achse liegt unterhalb des Bildes (typisch für Kurzdistanz-Beamer).
// cyFlip: true = je nach Menü-Modus (Decke/Tisch, Spiegel) kann das Bild auf dem Kopf stehen,
//         dann liegt die Achse oberhalb (1 - cyFrac). Der Solver testet dann beide Varianten.

export const LENS_PRESETS = [
  {
    id: 'epson-eb535w-1080p',
    name: 'Epson EB-535W – 1080p-Signal (16:9 im 16:10-Panel)',
    note: 'Wurfverhältnis 0,48 (Wide) bis 0,65 (Tele, digitaler Zoom). Offset 9,51:-1 → Achse liegt ca. 12 % der Bildhöhe unter dem Bild.',
    throwMin: 0.44,
    throwMax: 0.7,
    throwNominal: 0.48,
    throwSigma: 0.06,
    cxFrac: 0.5,
    cxSigmaFrac: 0.03,
    // Panel 1280x800 ≙ 1920x1200 bei Signal-Skalierung 1,5; 1080p liegt mittig (60 px Rand).
    // Achse: 1200 * (1 + 1/8.51) = 1341 → im Signal 1341 - 60 = 1281 → 1281/1080
    cyFrac: 1.186,
    cySigmaFrac: 0.06,
    cyFlip: true,
  },
  {
    id: 'epson-eb535w-wxga',
    name: 'Epson EB-535W – natives WXGA-Signal (1280x800)',
    note: 'Wenn das Signal exakt 1280x800 ist.',
    throwMin: 0.44,
    throwMax: 0.7,
    throwNominal: 0.48,
    throwSigma: 0.06,
    cxFrac: 0.5,
    cxSigmaFrac: 0.03,
    cyFrac: 1.1175,
    cySigmaFrac: 0.06,
    cyFlip: true,
  },
  {
    id: 'standard-offset',
    name: 'Standard-Beamer mit festem Offset (Achse an Bildunterkante)',
    note: 'Typische Büro-/Tischbeamer ohne Lens-Shift.',
    throwMin: 0.8,
    throwMax: 2.5,
    throwNominal: 1.4,
    throwSigma: 0.5,
    cxFrac: 0.5,
    cxSigmaFrac: 0.04,
    cyFrac: 1.0,
    cySigmaFrac: 0.12,
    cyFlip: true,
  },
  {
    id: 'lens-shift-centered',
    name: 'Beamer mit Lens-Shift, zentriert',
    note: 'Achse in Bildmitte (Lens-Shift auf 0).',
    throwMin: 0.3,
    throwMax: 4,
    throwNominal: 1.5,
    throwSigma: 0.8,
    cxFrac: 0.5,
    cxSigmaFrac: 0.05,
    cyFrac: 0.5,
    cySigmaFrac: 0.1,
    cyFlip: false,
  },
  {
    id: 'unknown',
    name: 'Unbekannt (frei, mind. 6 Punkte empfohlen)',
    note: 'Nur schwaches Vorwissen. Braucht gut verteilte Punkte.',
    throwMin: 0.2,
    throwMax: 5,
    throwNominal: 1.0,
    throwSigma: 2,
    cxFrac: 0.5,
    cxSigmaFrac: 0.2,
    cyFrac: 0.5,
    cySigmaFrac: 0.6,
    cyFlip: false,
  },
];

export function getLensPreset(id) {
  return LENS_PRESETS.find((p) => p.id === id) || LENS_PRESETS[LENS_PRESETS.length - 1];
}
