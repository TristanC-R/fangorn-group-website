import { downloadTextFile, toCsv } from "./fileExport.js";

const ACCOUNT_CODES = {
  grain_sale: "200",
  livestock_sale: "210",
  subsidy: "220",
  contracting_income: "230",
  seed: "300",
  chemical: "310",
  fertiliser: "320",
  fuel: "330",
  vet: "340",
  contractor: "350",
  rent: "360",
  machinery: "370",
  insurance: "380",
  labour: "390",
  feed: "400",
  other: "999",
};

export function buildXeroBankCsv(transactions) {
  return toCsv(transactions, [
    { label: "Date", value: (t) => t.date || "" },
    { label: "Amount", value: (t) => (t.type === "expense" ? -Math.abs(Number(t.amount) || 0) : Number(t.amount) || 0).toFixed(2) },
    { label: "Payee", value: (t) => t.counterparty || "" },
    { label: "Description", value: (t) => t.description || t.notes || "" },
    { label: "Reference", value: (t) => t.invoiceRef || "" },
    { label: "Account Code", value: (t) => ACCOUNT_CODES[t.category] || ACCOUNT_CODES.other },
    { label: "Tax Amount", value: (t) => (Number(t.vatAmount) || 0).toFixed(2) },
  ]);
}

export function downloadXeroBankCsv(transactions, farmName = "farm") {
  const safeFarm = String(farmName || "farm").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  downloadTextFile(`xero-bank-import-${safeFarm}-${date}.csv`, "text/csv", buildXeroBankCsv(transactions));
}
