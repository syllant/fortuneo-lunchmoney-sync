export const syntheticAccount = {
  uid: "account-opaque-1",
  identification_hash: "synthetic-identification-hash",
  name: "Synthetic checking account",
  currency: "EUR",
};

export const syntheticBookedTransaction = {
  transaction_id: "transaction-opaque-1",
  transaction_amount: { amount: "12.34", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2026-08-10",
  creditor: { name: "Synthetic merchant" },
  remittance_information: ["Synthetic purchase"],
};

export const syntheticPendingTransaction = {
  ...syntheticBookedTransaction,
  transaction_id: "transaction-opaque-pending",
  status: "PDNG",
};
