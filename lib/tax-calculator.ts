// FILE: lib/tax-calculator.ts
// Purpose: Pure, side-effect-free Italian forfettario tax breakdown for App Store earnings.
// Layer: Utility
// Exports: computeTaxBreakdown, TAX_CONSTANTS, types
// Depends on: nothing (intentionally side-effect-free for testability)

// ─── Domain types ─────────────────────────────────────────────

// Italian forfettario regime: 5% (start-up window, first 5 years with the
// usual eligibility) vs 15% (a regime, dal 6° anno).
export type ForfettarioRegime = "startup" | "regime";

// INPS Gestione Separata 2026 (verificato su circolare INPS n. 8 del 03/02/2026):
//   - "full"    = professionista senza altra copertura previdenziale → 26,07%
//                 (25% IVS + 0,72% maternità/malattia + 0,35% ISCRO)
//   - "partial" = pensionato o iscritto ad altra forma obbligatoria → 24,00%
// La Gestione Separata NON ha contributi minimi per i professionisti puri:
// si paga in proporzione all'imponibile. È diversa dalla Gestione Artigiani
// (per chi si iscrive in CCIAA come "produzione di software"), che invece
// ha minimali fissi (€4.521,36/anno sotto reddito €18.808 nel 2026).
export type InpsCoverage = "full" | "partial";

// "percent": INPS = inps_rate × imponibile (regola standard Gestione Separata).
// "fixed":   INPS = importo fisso annuo scelto dall'utente. Utile a chi è in
//            Gestione Artigiani (minimali), a chi vuole stimare un valore
//            "secco" senza dipendere dal fatturato, o per simulazioni
//            conservative. È il default perché gli utenti tipicamente
//            "vedono" il loro INPS come una spesa fissa annua.
export type InpsMode = "fixed" | "percent";

// Apple App Store commission tier: 15% under Small Business Program (proventi
// previous year < $1M USD; vale anche per le subscription dal day one se
// iscritti); 30% standard.
export type AppleCutTier = "sbp" | "standard";

// Costi opzionali ricorrenti annuali tipici di un forfettario sviluppatore.
// Ognuno è on/off: quando off, contribuisce 0 al totale. I valori sono
// modificabili dall'utente per riflettere il proprio scenario reale.
export type ExtrasInputs = {
  // Marca da bollo €2 su ogni fattura > €77,47. Apple paga mensilmente → di
  // norma 12 fatture/anno × €2 = €24. Default 24 (sempre attivo).
  bollo: { enabled: boolean; amount: number };
  // Compenso commercialista — opzionale ma molto comune per forfettari che
  // non vogliono gestire dichiarativi e f24 in autonomia.
  commercialista: { enabled: boolean; amount: number };
  // PEC + firma digitale + canone SDI (es. Aruba Forfettario, FattureinCloud).
  pecFirma: { enabled: boolean; amount: number };
  // Diritto annuale Camera di Commercio: dovuto solo se iscritto come
  // "produzione di software" (artigiano) in CCIAA. Non dovuto per chi è
  // libero professionista in Gestione Separata.
  cciaa: { enabled: boolean; amount: number };
};

export type TaxInputs = {
  // Gross revenue *for the selected period*, in the chart's currency, before
  // any commission. Caller is responsible for currency consistency: the
  // RevenueCat fee threshold is denominated in USD but at this scale and
  // with EUR ~ USD 1:1 the difference is sub-percent.
  grossPeriod: number;
  // Length of the period in days. Used to annualize before applying yearly
  // tax rules (INPS, RC fee threshold).
  periodDays: number;
  appleCut: AppleCutTier;
  regime: ForfettarioRegime;
  // INPS configuration: choose "fixed" + amount for a flat yearly value, or
  // "percent" + coverage tier for the proportional Gestione Separata rate.
  inpsMode: InpsMode;
  inps: InpsCoverage;
  inpsFixed: number;
  extras: ExtrasInputs;
};

export type TaxBreakdown = {
  // ── Gross side ──
  // Gross revenue projected to a full year (= grossPeriod / periodDays * 365).
  // We work in annualized space because both RC's fee threshold and INPS
  // brackets are inherently yearly; converting once up front makes every
  // downstream number comparable.
  annualGross: number;
  // Apple's commission for the year (positive number; subtracted from gross).
  appleCommission: number;
  // What Apple actually wires you over a year. This is the "ricavi forfettari"
  // value that Italian tax law sees: a forfettario records what they receive
  // from Apple (already net of Apple's commission AND of the IVA Apple has
  // already collected & paid as MoR for EU consumers), not the gross sale.
  appleProceeds: number;

  // ── Forfettario maths ──
  // 33% of proceeds, automatically deemed-deducted by the regime. Shown for
  // transparency only — it isn't a payment, it's the part of revenue that
  // never gets taxed.
  forfettariCosts: number;
  // 67% of proceeds. This is the base on which both INPS (when in percent
  // mode) and the imposta sostitutiva are computed.
  imponibile: number;
  // 5% or 15% of imponibile.
  impostaSostitutiva: number;
  // Either inpsFixed (mode="fixed") or inps_rate × imponibile (mode="percent").
  inpsContributi: number;

  // ── RevenueCat ──
  // Yearly RevenueCat invoice. Calculated as max(0, monthly_avg - 2500) * 1%
  // * 12. RC bills monthly, but for this estimator we assume a flat monthly
  // distribution — accurate for steady-state apps, slightly off for highly
  // seasonal ones.
  revenueCatFee: number;
  // 22% of revenueCatFee. In ordinario you'd net this against the IVA you
  // collect; in forfettario you just pay it (no IVA collection to offset).
  ivaReverseCharge: number;

  // ── Extras (ricorrenti annuali, somma soggetta ai toggles) ──
  extrasTotal: number;
  // Per-row breakdown so the UI can show each extra individually.
  extras: {
    bollo: number;
    commercialista: number;
    pecFirma: number;
    cciaa: number;
  };

  // ── Bottom line ──
  // What you actually keep in a year. Forfettario rule: nessuna spesa è
  // deducibile, quindi imposta + INPS sono calcolate sull'imponibile lordo
  // (67% di appleProceeds) e poi RC fee, IVA reverse charge ed extras sono
  // sottratti come uscite di cassa "vive" senza ridurre la base imponibile.
  net: number;
  // net / 12, useful as the "monthly take-home" headline below the annual one.
  netMonthly: number;
};

// ─── Rates (centralised so future law/pricing changes are one-line edits) ──

export const TAX_CONSTANTS = {
  // Apple commission tiers.
  APPLE_RATES: {
    sbp: 0.15,
    standard: 0.30
  } as const satisfies Record<AppleCutTier, number>,

  // Forfettario imposta sostitutiva.
  REGIME_RATES: {
    startup: 0.05,
    regime: 0.15
  } as const satisfies Record<ForfettarioRegime, number>,

  // INPS Gestione Separata aliquote 2026 (circolare INPS n. 8 del 03/02/2026).
  INPS_RATES: {
    full: 0.2607,
    partial: 0.24
  } as const satisfies Record<InpsCoverage, number>,

  // 67% del fatturato è imponibile (codice ATECO 62.01.00 - "Produzione di
  // software non connesso all'edizione", categoria "Altre attività"). Il 33%
  // complementare è la spesa forfettaria.
  FORFETTARIO_COEFFICIENT: 0.67,

  // RevenueCat: 1% del MTR mensile oltre $ 2.500 (Free tier).
  RC_FREE_TIER: 2500,
  RC_FEE_RATE: 0.01,

  // IVA reverse charge sui servizi B2B extra-UE (RevenueCat Inc. è USA).
  IVA_RATE: 0.22
} as const;

// Default extras: amounts realistici per uno sviluppatore solo che fattura
// mensilmente ad Apple. L'utente può modificarli o disattivarli.
export const DEFAULT_EXTRAS: ExtrasInputs = {
  // 12 fatture Apple/anno × €2.
  bollo: { enabled: true, amount: 24 },
  // Tipico forfait commercialista per forfettario (range €600–€1.500).
  commercialista: { enabled: true, amount: 1000 },
  // PEC Aruba ~€10/anno + firma digitale ~€30/anno + SDI free → ~€60.
  pecFirma: { enabled: true, amount: 60 },
  // Off di default: vale solo se iscritto in CCIAA come artigiano.
  cciaa: { enabled: false, amount: 100 }
};

// Default INPS fisso (EUR/anno). Scelto per allinearsi a:
//   - quanto un forfettario "vede" come spesa annua INPS percepita
//   - il minimale Gestione Artigiani ridotto -35% per forfettari (~€2.939)
//     o pieno (€4.521) — €4.000 sta in mezzo come stima conservativa
//   - INPS Gestione Separata su redditi medio-bassi (imponibile €15k → €3.9k)
export const DEFAULT_INPS_FIXED = 4000;

// ─── ENTRY POINT ─────────────────────────────────────────────

export function computeTaxBreakdown(inputs: TaxInputs): TaxBreakdown {
  const {
    APPLE_RATES,
    REGIME_RATES,
    INPS_RATES,
    FORFETTARIO_COEFFICIENT,
    RC_FREE_TIER,
    RC_FEE_RATE,
    IVA_RATE
  } = TAX_CONSTANTS;

  // Annualize period revenue. Guards against a 0-day period (theoretical,
  // would only happen with corrupt data).
  const annualGross =
    inputs.periodDays > 0 ? (inputs.grossPeriod / inputs.periodDays) * 365 : 0;

  // Apple side. Apple agisce anche come Merchant of Record per le sales B2C
  // intra-UE → l'IVA è già stata raccolta e versata da Apple, e il bonifico
  // che riceviamo è già IVA-free. Quindi nessuna sottrazione ulteriore qui.
  const appleRate = APPLE_RATES[inputs.appleCut];
  const appleCommission = annualGross * appleRate;
  const appleProceeds = annualGross - appleCommission;

  // Forfettario maths. Tutto da qui in giù opera su `appleProceeds`,
  // perché ciò che incassi da Apple è ciò che il fisco italiano vede come
  // tuoi "ricavi" — la commissione di Apple è già scalata prima che tu veda
  // il bonifico, e non è una tua entrata da dichiarare.
  const imponibile = appleProceeds * FORFETTARIO_COEFFICIENT;
  const forfettariCosts = appleProceeds - imponibile; // = appleProceeds * 0.33

  const impostaSostitutiva = imponibile * REGIME_RATES[inputs.regime];

  // INPS: due modalità. "fixed" è il default perché gli utenti spesso
  // pensano all'INPS come a una spesa fissa annua (vero per Gestione
  // Artigiani, e per molti professionisti è una stima utile). "percent" è
  // la regola tecnica per Gestione Separata.
  const inpsContributi =
    inputs.inpsMode === "fixed"
      ? Math.max(0, inputs.inpsFixed)
      : imponibile * INPS_RATES[inputs.inps];

  // RevenueCat fee: soglia mensile, billing mensile. Annualizzato = monthly × 12.
  // La soglia è in USD: per dashboard EUR si applica con errore ~3-5% (1 USD
  // ≈ 0,92-0,95 EUR nel 2025-2026). Il calcolatore non converte: l'utente
  // vede il numero nella valuta della dashboard.
  const monthlyGross = annualGross / 12;
  const revenueCatFee = Math.max(0, monthlyGross - RC_FREE_TIER) * RC_FEE_RATE * 12;

  // IVA reverse charge sulla RC fee. In forfettario registri l'autofattura
  // e versi l'IVA, ma non puoi detrarla (in forfettario non addebiti IVA
  // sulle tue vendite, quindi non hai nulla da compensare).
  const ivaReverseCharge = revenueCatFee * IVA_RATE;

  // Extras: ognuno contribuisce solo se enabled. Importi >= 0.
  const extrasResolved = {
    bollo: inputs.extras.bollo.enabled ? Math.max(0, inputs.extras.bollo.amount) : 0,
    commercialista: inputs.extras.commercialista.enabled
      ? Math.max(0, inputs.extras.commercialista.amount)
      : 0,
    pecFirma: inputs.extras.pecFirma.enabled ? Math.max(0, inputs.extras.pecFirma.amount) : 0,
    cciaa: inputs.extras.cciaa.enabled ? Math.max(0, inputs.extras.cciaa.amount) : 0
  };
  const extrasTotal =
    extrasResolved.bollo + extrasResolved.commercialista + extrasResolved.pecFirma + extrasResolved.cciaa;

  // Cassa netta finale. Forfettario: nulla è deducibile, quindi RC fee, IVA
  // ed extras NON riducono l'imponibile (imposta e INPS sono già calcolate
  // sopra sulla base imponibile lorda) — vengono solo sottratti come uscite
  // di cassa reali.
  const net =
    appleProceeds -
    impostaSostitutiva -
    inpsContributi -
    revenueCatFee -
    ivaReverseCharge -
    extrasTotal;

  return {
    annualGross,
    appleCommission,
    appleProceeds,
    forfettariCosts,
    imponibile,
    impostaSostitutiva,
    inpsContributi,
    revenueCatFee,
    ivaReverseCharge,
    extrasTotal,
    extras: extrasResolved,
    net,
    netMonthly: net / 12
  };
}
