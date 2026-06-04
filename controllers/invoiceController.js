const { supabaseAdmin } = require("../config/supabase");
const { getSettingsForHall } = require("./hallSettingsController");

/* ============================================================
   GENERATE NEXT INVOICE NUMBER
   Format: INV-2024-0001 (prefix from settings)
   ============================================================ */
const generateInvoiceNumber = async (hall_id, prefix = "INV") => {
  const year = new Date().getFullYear();

  const { count } = await supabaseAdmin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("hall_id", hall_id)
    .ilike("invoice_number", `${prefix}-${year}-%`);

  const sequence = String((count || 0) + 1).padStart(4, "0");
  return `${prefix}-${year}-${sequence}`;
};

/* ============================================================
   CREATE INVOICE FOR BOOKING
   ============================================================ */
const createInvoice = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { booking_id, due_date, line_items, discount_amount, notes } = req.body;

    if (!booking_id) return res.status(400).json({ message: "booking_id is required" });

    // Check if invoice already exists for this booking
    const { data: existing } = await supabaseAdmin
      .from("invoices")
      .select("id, invoice_number")
      .eq("booking_id", booking_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        message: "Invoice already exists for this booking",
        invoice_id: existing.id,
        invoice_number: existing.invoice_number,
      });
    }

    // Fetch booking with full details
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select(`
        *,
        customers ( id, customer_name, phone, email, address ),
        payments ( id, amount, payment_method, payment_date )
      `)
      .eq("id", booking_id)
      .eq("hall_id", hall_id)
      .single();

    if (!booking) return res.status(404).json({ message: "Booking not found in your hall" });
    if (booking.status === "cancelled") {
      return res.status(400).json({ message: "Cannot create invoice for a cancelled booking" });
    }

    // Fetch hall profile and settings
    const settings = await getSettingsForHall(hall_id);
    const { data: hallProfile } = await supabaseAdmin
      .from("hall_profiles")
      .select("hall_name, phone, email, address, city, logo_url, gstin")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name, phone, email, address, city")
      .eq("id", hall_id)
      .single();

    const invoiceNumber = await generateInvoiceNumber(hall_id, settings.invoice_prefix);

    // Build line items — use provided ones or auto-generate from booking
    const items = line_items || [
      {
        description: booking.event_name || "Hall Booking",
        quantity: 1,
        unit_price: booking.total_amount || 0,
        amount: booking.total_amount || 0,
      },
    ];

    const subtotal = items.reduce((s, item) => s + (item.amount || 0), 0);
    const discount = discount_amount || 0;
    const taxable_amount = subtotal - discount;
    const tax_amount = settings.tax_enabled
      ? Math.round((taxable_amount * settings.tax_percentage) / 100 * 100) / 100
      : 0;
    const total_amount = taxable_amount + tax_amount;

    // Amount paid so far
    const amount_paid = (booking.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance_due = total_amount - amount_paid;

    const invoiceData = {
      hall_id,
      booking_id,
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().split("T")[0],
      due_date: due_date || null,

      // Customer snapshot
      customer_name: booking.customers?.customer_name,
      customer_phone: booking.customers?.phone,
      customer_email: booking.customers?.email,
      customer_address: booking.customers?.address,

      // Hall snapshot
      hall_name: hallProfile?.hall_name || hall?.hall_name,
      hall_phone: hallProfile?.phone || hall?.phone,
      hall_email: hallProfile?.email || hall?.email,
      hall_address: hallProfile?.address
        ? `${hallProfile.address}, ${hallProfile.city || ""}`
        : hall?.address,
      hall_logo_url: hallProfile?.logo_url || null,
      hall_gstin: hallProfile?.gstin || null,

      // Booking snapshot
      event_name: booking.event_name,
      event_type: booking.event_type,
      event_date: booking.start_date,
      event_end_date: booking.end_date,

      // Financial
      line_items: items,
      subtotal,
      discount_amount: discount,
      tax_enabled: settings.tax_enabled,
      tax_percentage: settings.tax_percentage,
      tax_label: settings.tax_label,
      tax_amount,
      total_amount,
      amount_paid,
      balance_due,
      currency: settings.currency,
      currency_symbol: settings.currency_symbol,

      // Meta
      notes: notes || settings.invoice_footer_note,
      status: balance_due <= 0 ? "paid" : "unpaid",
    };

    const { data, error } = await supabaseAdmin
      .from("invoices")
      .insert([invoiceData])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: "Invoice created successfully", data });
  } catch (err) {
    console.error("createInvoice error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET INVOICE BY ID
   ============================================================ */
const getInvoiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Invoice not found" });

    res.json(data);
  } catch (err) {
    console.error("getInvoiceById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET INVOICE BY BOOKING ID
   ============================================================ */
const getInvoiceByBooking = async (req, res) => {
  try {
    const { booking_id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("booking_id", booking_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: "No invoice found for this booking" });

    res.json(data);
  } catch (err) {
    console.error("getInvoiceByBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL INVOICES
   ============================================================ */
const getInvoices = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("invoices")
      .select("*", { count: "exact" })
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq("status", status);
    if (from_date) query = query.gte("invoice_date", from_date);
    if (to_date) query = query.lte("invoice_date", to_date);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const totalAmount = data.reduce((s, inv) => s + (inv.total_amount || 0), 0);
    const totalPaid = data.reduce((s, inv) => s + (inv.amount_paid || 0), 0);

    res.json({
      data,
      summary: {
        total_invoiced: totalAmount,
        total_paid: totalPaid,
        total_outstanding: totalAmount - totalPaid,
        count,
      },
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getInvoices error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE INVOICE STATUS
   Used when payment is recorded — sync invoice status
   ============================================================ */
const updateInvoiceStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("id, booking_id, total_amount")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    // Recalculate from payments
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("booking_id", invoice.booking_id);

    const amount_paid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance_due = (invoice.total_amount || 0) - amount_paid;

    const status = balance_due <= 0 ? "paid" : amount_paid > 0 ? "partial" : "unpaid";

    const { error } = await supabaseAdmin
      .from("invoices")
      .update({ amount_paid, balance_due, status })
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Invoice status refreshed", status, amount_paid, balance_due });
  } catch (err) {
    console.error("updateInvoiceStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET INVOICE HTML (for PDF generation or print)
   Returns a clean HTML string the frontend can print or convert
   ============================================================ */
const getInvoiceHtml = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: inv, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Invoice not found" });

    const symbol = inv.currency_symbol || "₹";
    const fmt = (n) => `${symbol}${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

    const lineItemsHtml = (inv.line_items || [])
      .map(
        (item) => `
        <tr>
          <td>${item.description || ""}</td>
          <td style="text-align:center">${item.quantity || 1}</td>
          <td style="text-align:right">${fmt(item.unit_price)}</td>
          <td style="text-align:right">${fmt(item.amount)}</td>
        </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${inv.invoice_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #333; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .hall-name { font-size: 22px; font-weight: 700; color: #1a1a1a; }
  .hall-details { font-size: 12px; color: #666; margin-top: 4px; line-height: 1.6; }
  .invoice-meta { text-align: right; }
  .invoice-meta h2 { font-size: 28px; color: #4f46e5; letter-spacing: 1px; }
  .invoice-meta p { font-size: 12px; color: #666; margin-top: 4px; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .party-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888; margin-bottom: 6px; letter-spacing: 0.5px; }
  .party-name { font-size: 15px; font-weight: 600; color: #1a1a1a; }
  .party-detail { font-size: 12px; color: #666; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  thead th { background: #f3f4f6; padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; color: #555; }
  tbody td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
  .totals { margin-left: auto; width: 280px; }
  .totals table { font-size: 13px; }
  .totals td { padding: 5px 8px; }
  .totals .label { color: #666; }
  .totals .amount { text-align: right; font-weight: 500; }
  .total-row td { font-size: 15px; font-weight: 700; border-top: 2px solid #333; padding-top: 8px; }
  .balance-row td { color: #4f46e5; font-size: 16px; font-weight: 700; }
  .paid-row td { color: #16a34a; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  .status-paid { background: #dcfce7; color: #16a34a; }
  .status-unpaid { background: #fee2e2; color: #dc2626; }
  .status-partial { background: #fef3c7; color: #d97706; }
  .footer { margin-top: 40px; font-size: 12px; color: #888; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      ${inv.hall_logo_url ? `<img src="${inv.hall_logo_url}" alt="Logo" style="height:52px;margin-bottom:8px;display:block">` : ""}
      <div class="hall-name">${inv.hall_name || "Hall Name"}</div>
      <div class="hall-details">
        ${inv.hall_address ? inv.hall_address + "<br>" : ""}
        ${inv.hall_phone ? "Phone: " + inv.hall_phone + "<br>" : ""}
        ${inv.hall_email ? "Email: " + inv.hall_email + "<br>" : ""}
        ${inv.hall_gstin ? "GSTIN: " + inv.hall_gstin : ""}
      </div>
    </div>
    <div class="invoice-meta">
      <h2>INVOICE</h2>
      <p><strong>${inv.invoice_number}</strong></p>
      <p>Date: ${inv.invoice_date}</p>
      ${inv.due_date ? `<p>Due: ${inv.due_date}</p>` : ""}
      <br>
      <span class="status-badge status-${inv.status}">${inv.status?.toUpperCase()}</span>
    </div>
  </div>

  <hr class="divider">

  <div class="parties">
    <div>
      <div class="party-label">Bill To</div>
      <div class="party-name">${inv.customer_name || ""}</div>
      <div class="party-detail">
        ${inv.customer_phone ? "Phone: " + inv.customer_phone + "<br>" : ""}
        ${inv.customer_email ? "Email: " + inv.customer_email + "<br>" : ""}
        ${inv.customer_address || ""}
      </div>
    </div>
    <div>
      <div class="party-label">Event Details</div>
      <div class="party-name">${inv.event_name || inv.event_type || ""}</div>
      <div class="party-detail">
        ${inv.event_date ? "Date: " + inv.event_date + (inv.event_end_date && inv.event_end_date !== inv.event_date ? " to " + inv.event_end_date : "") + "<br>" : ""}
        ${inv.event_type ? "Type: " + inv.event_type : ""}
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:center">Qty</th>
        <th style="text-align:right">Unit Price</th>
        <th style="text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td class="label">Subtotal</td><td class="amount">${fmt(inv.subtotal)}</td></tr>
      ${inv.discount_amount ? `<tr><td class="label">Discount</td><td class="amount">- ${fmt(inv.discount_amount)}</td></tr>` : ""}
      ${inv.tax_enabled ? `<tr><td class="label">${inv.tax_label || "Tax"} (${inv.tax_percentage}%)</td><td class="amount">${fmt(inv.tax_amount)}</td></tr>` : ""}
      <tr class="total-row"><td>Total</td><td class="amount">${fmt(inv.total_amount)}</td></tr>
      ${inv.amount_paid > 0 ? `<tr class="paid-row"><td class="label">Amount Paid</td><td class="amount">- ${fmt(inv.amount_paid)}</td></tr>` : ""}
      <tr class="balance-row"><td>Balance Due</td><td class="amount">${fmt(inv.balance_due)}</td></tr>
    </table>
  </div>

  ${inv.notes ? `<div class="footer">${inv.notes}</div>` : ""}
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("getInvoiceHtml error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CREATE PAYMENT RECEIPT
   Lightweight receipt for a single payment
   ============================================================ */
const createReceipt = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { payment_id } = req.params;

    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select(`
        *,
        bookings (
          id, event_name, event_type, start_date, end_date, total_amount,
          customers ( customer_name, phone, email, address )
        )
      `)
      .eq("id", payment_id)
      .eq("hall_id", hall_id)
      .single();

    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const settings = await getSettingsForHall(hall_id);
    const { data: hallProfile } = await supabaseAdmin
      .from("hall_profiles")
      .select("hall_name, phone, email, address, city, logo_url")
      .eq("hall_id", hall_id)
      .maybeSingle();
    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name, phone, email, address")
      .eq("id", hall_id)
      .single();

    // Generate receipt number
    const year = new Date().getFullYear();
    const { count } = await supabaseAdmin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("hall_id", hall_id)
      .ilike("invoice_number", `${settings.receipt_prefix}-%`);

    const receiptNumber = `${settings.receipt_prefix}-${year}-${String((count || 0) + 1).padStart(4, "0")}`;
    const symbol = settings.currency_symbol || "₹";
    const fmt = (n) => `${symbol}${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Receipt ${receiptNumber}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size:13px; color:#333; }
  .receipt { max-width:420px; margin:0 auto; padding:32px; border:1px solid #e5e7eb; }
  .header { text-align:center; margin-bottom:24px; }
  .hall-name { font-size:18px; font-weight:700; }
  .hall-sub { font-size:11px; color:#888; margin-top:4px; }
  h2 { font-size:16px; letter-spacing:2px; color:#4f46e5; margin:16px 0 4px; }
  .receipt-no { font-size:12px; color:#888; }
  .divider { border:none; border-top:1px dashed #ccc; margin:16px 0; }
  .row { display:flex; justify-content:space-between; margin:6px 0; font-size:12px; }
  .row .label { color:#666; }
  .amount-row { font-size:16px; font-weight:700; color:#1a1a1a; margin:12px 0; }
  .footer { text-align:center; font-size:11px; color:#aaa; margin-top:24px; }
  @media print { .receipt { border:none; } }
</style>
</head>
<body>
<div class="receipt">
  <div class="header">
    ${hallProfile?.logo_url ? `<img src="${hallProfile.logo_url}" alt="Logo" style="height:44px;margin-bottom:8px">` : ""}
    <div class="hall-name">${hallProfile?.hall_name || hall?.hall_name || "Hall Name"}</div>
    <div class="hall-sub">${hallProfile?.address || hall?.address || ""}</div>
    <h2>RECEIPT</h2>
    <div class="receipt-no">${receiptNumber}</div>
  </div>

  <hr class="divider">

  <div class="row"><span class="label">Customer</span><span>${payment.bookings?.customers?.customer_name || ""}</span></div>
  <div class="row"><span class="label">Phone</span><span>${payment.bookings?.customers?.phone || ""}</span></div>
  <div class="row"><span class="label">Event</span><span>${payment.bookings?.event_name || payment.bookings?.event_type || ""}</span></div>
  <div class="row"><span class="label">Event Date</span><span>${payment.bookings?.start_date || ""}</span></div>

  <hr class="divider">

  <div class="row"><span class="label">Payment Date</span><span>${payment.payment_date}</span></div>
  <div class="row"><span class="label">Payment Method</span><span style="text-transform:capitalize">${payment.payment_method || "cash"}</span></div>
  ${payment.notes ? `<div class="row"><span class="label">Notes</span><span>${payment.notes}</span></div>` : ""}

  <hr class="divider">

  <div class="row amount-row"><span>Amount Paid</span><span>${fmt(payment.amount)}</span></div>

  <hr class="divider">

  <div class="footer">${settings.invoice_footer_note || "Thank you for your payment."}</div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("createReceipt error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createInvoice,
  getInvoiceById,
  getInvoiceByBooking,
  getInvoices,
  updateInvoiceStatus,
  getInvoiceHtml,
  createReceipt,
};