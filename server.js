require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

// Compatibilidad de import: algunas instalaciones usan @afipsdk/afip.js y otras afip.js
let Afip;
try {
  Afip = require("@afipsdk/afip.js");
} catch (e) {
  Afip = require("afip.js");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const CUIT = Number(process.env.CUIT || "30716967227");
const AFIP_ENV = (process.env.AFIP_ENV || "prod").toLowerCase(); // homo | prod
const CERT_PATH = process.env.CERT_PATH || "./certs/certificado.crt";
const KEY_PATH = process.env.KEY_PATH || "./certs/privada.key";
const PTO_VTA_DEFAULT = Number(process.env.PTO_VTA_DEFAULT || 1);

function auth(req, res, next) {
  const key =
    req.header("x-api-key") ||
    req.header("X-POS-Secret") ||
    (req.header("Authorization") || "").replace(/^Bearer\s+/i, "");

  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, success: false, error: "Unauthorized" });
  }
  next();
}


function readCerts() {
  const cert = fs.readFileSync(path.resolve(CERT_PATH), "utf8");
  const key = fs.readFileSync(path.resolve(KEY_PATH), "utf8");
  return { cert, key };
}

function getAfip() {
  const { cert, key } = readCerts();

  if (!process.env.AFIP_ACCESS_TOKEN) {
    throw new Error("Falta AFIP_ACCESS_TOKEN en el archivo .env");
  }

  return new Afip({
    CUIT,
    cert,
    key,
    production: AFIP_ENV === "prod",
    access_token: process.env.AFIP_ACCESS_TOKEN,
  });
}

function toNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function round2(n) {
  return Math.round((toNumber(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Mapea condición IVA del receptor a DocTipo AFIP más común:
 * 80 = CUIT
 * 96 = DNI
 * 99 = Consumidor Final
 */
function mapDocTipo(receptor = {}) {
  if (receptor.docTipo) return Number(receptor.docTipo);
  const cuit = String(receptor.cuit || receptor.docNro || "").replace(/\D/g, "");
  if (cuit.length === 11) return 80;
  if (cuit.length === 7 || cuit.length === 8) return 96;
  return 99;
}

function mapDocNro(receptor = {}, docTipo) {
  if (docTipo === 99) return 0;
  const nro = String(receptor.docNro || receptor.cuit || "").replace(/\D/g, "");
  return nro ? Number(nro) : 0;
}

/**
 * CbteTipo frecuentes:
 * 1 = Factura A
 * 6 = Factura B
 * 11 = Factura C
 */
function mapCbteTipo(input = {}) {
  if (input.cbteTipo) return Number(input.cbteTipo);
  const tipo = String(input.tipoComprobante || input.tipo || "").toUpperCase();
  if (tipo.includes("A")) return 1;
  if (tipo.includes("C")) return 11;
  return 6; // default B
}

function buildIvaArray(items = []) {
  // Agrupa por alícuota IVA
  // ID AFIP IVA:
  // 3 = 0%
  // 4 = 10.5%
  // 5 = 21%
  // 6 = 27%
  const map = new Map();

  for (const item of items) {
    const ivaPct = round2(item.iva ?? item.alicuotaIva ?? 21);
    const neto = round2(item.neto ?? item.importeNeto ?? ((toNumber(item.importe) || toNumber(item.subtotal) || 0) / (1 + ivaPct / 100)));
    const impIva = round2(item.impIva ?? (neto * ivaPct) / 100);

    let id = 5;
    if (ivaPct === 0) id = 3;
    else if (ivaPct === 10.5) id = 4;
    else if (ivaPct === 21) id = 5;
    else if (ivaPct === 27) id = 6;

    const prev = map.get(id) || { Id: id, BaseImp: 0, Importe: 0 };
    prev.BaseImp = round2(prev.BaseImp + neto);
    prev.Importe = round2(prev.Importe + impIva);
    map.set(id, prev);
  }

  return Array.from(map.values()).filter((x) => x.BaseImp > 0 || x.Importe > 0);
}

function buildVoucherPayload(body) {
  const receptor = body.receptor || body.cliente || {};
  const items = Array.isArray(body.items) ? body.items : [];

  const cbteTipo = mapCbteTipo(body);
  const ptoVta = Number(body.ptoVta || body.puntoVenta || PTO_VTA_DEFAULT);
  const docTipo = mapDocTipo(receptor);
  const docNro = mapDocNro(receptor, docTipo);

  // Totales: preferí los del backend si ya vienen calculados
  let impNeto = round2(body.impNeto);
  let impIVA = round2(body.impIVA);
  let impTotal = round2(body.impTotal);
  let impOpEx = round2(body.impOpEx || 0);
  let impTotConc = round2(body.impTotConc || 0);
  let impTrib = round2(body.impTrib || 0);

  const ivaArray = body.ivaArray || buildIvaArray(items);

  if (!impNeto) {
    impNeto = round2(ivaArray.reduce((a, x) => a + toNumber(x.BaseImp), 0));
  }
  if (!impIVA) {
    impIVA = round2(ivaArray.reduce((a, x) => a + toNumber(x.Importe), 0));
  }
  if (!impTotal) {
    impTotal = round2(impNeto + impIVA + impOpEx + impTotConc + impTrib);
  }

  const concept = Number(body.concept || 1); // 1 productos
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const cbteFch = Number(body.cbteFch || `${yyyy}${mm}${dd}`);

  const payload = {
    CantReg: 1,
    PtoVta: ptoVta,
    CbteTipo: cbteTipo,
    Concepto: concept,
    DocTipo: docTipo,
    DocNro: docNro,
    CbteDesde: null, // se completa con último+1
    CbteHasta: null,
    CbteFch: cbteFch,
    ImpTotal: impTotal,
    ImpTotConc: impTotConc,
    ImpNeto: impNeto,
    ImpOpEx: impOpEx,
    ImpIVA: impIVA,
    ImpTrib: impTrib,
    MonId: "PES",
    MonCotiz: 1,
  };

  // Condición IVA receptor (requerida en algunos entornos/WS recientes)
  // 1 RI, 4 Exento, 5 CF, 6 Monotributo (valores comunes)
  if (body.condicionIvaReceptorId || receptor.condicionIvaId) {
    payload.CondicionIVAReceptorId = Number(body.condicionIvaReceptorId || receptor.condicionIvaId);
  } else if (docTipo === 99) {
    payload.CondicionIVAReceptorId = 5; // CF
  }

  if (ivaArray.length) {
    payload.Iva = ivaArray;
  }

  // Para concepto 2/3 (servicios) se exigen fechas de servicio
  if (concept === 2 || concept === 3) {
    payload.FchServDesde = Number(body.fchServDesde || cbteFch);
    payload.FchServHasta = Number(body.fchServHasta || cbteFch);
    payload.FchVtoPago = Number(body.fchVtoPago || cbteFch);
  }

  return { payload, ptoVta, cbteTipo };
}

app.get("/health", async (req, res) => {
  try {
    // No autentica para que Render/monitoreo puedan chequear uptime
    const existsCert = fs.existsSync(path.resolve(CERT_PATH));
    const existsKey = fs.existsSync(path.resolve(KEY_PATH));
    res.json({
      ok: true,
      env: AFIP_ENV,
      cuit: CUIT,
      cert: existsCert,
      key: existsKey,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/afip/status", auth, async (req, res) => {
  try {
    const afip = getAfip();
    const serverStatus = await afip.ElectronicBilling.getServerStatus();
    res.json({ ok: true, serverStatus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, detail: String(err) });
  }
});

app.post("/facturar", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const afip = getAfip();
    const { payload, ptoVta, cbteTipo } = buildVoucherPayload(body);

    // Tomar próximo número
    const last = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
    const next = Number(last || 0) + 1;
    payload.CbteDesde = next;
    payload.CbteHasta = next;

    const result = await afip.ElectronicBilling.createVoucher(payload);

    // result suele traer CAE y CAEFchVto
    return res.json({
      ok: true,
      env: AFIP_ENV,
      ptoVta,
      cbteTipo,
      cbteNro: next,
      cae: result.CAE || result.cae || null,
      caeVto: result.CAEFchVto || result.caeFchVto || null,
      afipResult: result,
      requestPayload: payload,
    });
  } catch (err) {
    console.error("Error /facturar:", err);
    return res.status(400).json({
      ok: false,
      error: err.message || "Error al facturar",
      detail: err.err || err.response || String(err),
    });
  }
});

app.post("/facturar-test", auth, async (req, res) => {
  try {
    // Atajo para probar una Factura B a CF de $121 (neto 100 + iva 21)
    const demo = {
      tipoComprobante: "B",
      ptoVta: PTO_VTA_DEFAULT,
      receptor: {
        docTipo: 99,
        docNro: 0,
        condicionIvaId: 5,
      },
      impNeto: 100,
      impIVA: 21,
      impTotal: 121,
      ivaArray: [{ Id: 5, BaseImp: 100, Importe: 21 }],
      concept: 1,
    };

    const body = { ...demo, ...(req.body || {}) };
    const afip = getAfip();
    const { payload, ptoVta, cbteTipo } = buildVoucherPayload(body);

    const last = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
    const next = Number(last || 0) + 1;
    payload.CbteDesde = next;
    payload.CbteHasta = next;

    const result = await afip.ElectronicBilling.createVoucher(payload);

    return res.json({
      ok: true,
      env: AFIP_ENV,
      ptoVta,
      cbteTipo,
      cbteNro: next,
      cae: result.CAE || result.cae || null,
      caeVto: result.CAEFchVto || result.caeFchVto || null,
      afipResult: result,
      requestPayload: payload,
    });
  } catch (err) {
    console.error("Error /facturar-test:", err);
    return res.status(400).json({
      ok: false,
      error: err.message || "Error al facturar",
      detail: err.err || err.response || String(err),
    });
  }
});

/**
 * Contrato para Google Apps Script (arca.gs)
 * POST /api/arca/wsfe/emitir
 */
app.post("/api/arca/wsfe/emitir", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const comp = body.comprobante || {};
    const imp = comp.importes || {};
    const doc = comp.documentoReceptor || {};
    const emisor = body.emisor || {};
    const moneda = comp.moneda || {};

    // Mapear el JSON de Apps Script al formato que ya usa buildVoucherPayload
    const mapped = {
      tipoComprobante: Number(comp.tipo || 6),
      cbteTipo: Number(comp.tipo || 6),
      ptoVta: Number(emisor.puntoVenta || body.puntoVenta || PTO_VTA_DEFAULT),
      concept: Number(comp.concepto || 1),
      cbteFch: comp.fecha ? Number(comp.fecha) : undefined,
      receptor: {
        docTipo: Number(doc.tipo || 99),
        docNro: doc.numero != null ? Number(doc.numero) : 0,
        condicionIvaId: Number(comp.condicionIvaReceptor || 5),
      },
      condicionIvaReceptorId: Number(comp.condicionIvaReceptor || 5),
      impNeto: round2(imp.neto),
      impIVA: round2(imp.iva),
      impTotal: round2(imp.total),
      impOpEx: round2(imp.exento || 0),
      impTotConc: round2(imp.noGravado || 0),
      impTrib: round2(imp.tributos || 0),
      // arca.gs manda: [{ id, baseImponible, importe }]
      ivaArray: Array.isArray(comp.iva)
        ? comp.iva.map((x) => ({
            Id: Number(x.id ?? x.Id),
            BaseImp: round2(x.baseImponible ?? x.BaseImp ?? 0),
            Importe: round2(x.importe ?? x.Importe ?? 0),
          }))
        : [],
    };

    const afip = getAfip();
    const { payload, ptoVta, cbteTipo } = buildVoucherPayload(mapped);

    // Si Apps Script manda moneda, respetarla
    if (moneda.id) payload.MonId = String(moneda.id);
    if (moneda.cotizacion != null) payload.MonCotiz = Number(moneda.cotizacion) || 1;

    const last = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
    const next = Number(last || 0) + 1;
    payload.CbteDesde = next;
    payload.CbteHasta = next;

    const result = await afip.ElectronicBilling.createVoucher(payload);

    const cae = result.CAE || result.cae || null;
    const caeVto = result.CAEFchVto || result.caeFchVto || null;

    // Respuesta en el formato que espera facturarVentaArca (arca.gs)
    if (cae) {
      return res.status(200).json({
        success: true,
        resultado: "A",
        cae: String(cae),
        vencimientoCae: String(caeVto || ""),
        numeroComprobante: next,
        puntoVenta: ptoVta,
        tipoComprobante: cbteTipo,
        observaciones: [],
        errores: [],
        // compat
        ok: true,
        cbteNro: next,
        afipResult: result,
      });
    }

    return res.status(200).json({
      success: false,
      resultado: "R",
      message: "ARCA no devolvió CAE",
      errores: [{ codigo: "SIN_CAE", mensaje: "Respuesta sin CAE" }],
      observaciones: [],
      ok: false,
      afipResult: result,
      requestPayload: payload,
    });
  } catch (err) {
    console.error("Error /api/arca/wsfe/emitir:", err);
    return res.status(400).json({
      success: false,
      resultado: "R",
      message: err.message || "Error al facturar",
      error: err.message || "Error al facturar",
      errores: [
        {
          codigo: "MIDDLEWARE",
          mensaje: err.message || "Error al facturar",
        },
      ],
      ok: false,
      detail: err.err || err.response || String(err),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `ARCA middleware listening on :${PORT} [${AFIP_ENV}] CUIT=${CUIT}`
    );
  });
}

module.exports = app;
