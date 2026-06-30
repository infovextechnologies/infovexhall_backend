const { supabaseAdmin } = require("../config/supabase");
const { getSettingsForHall } = require("./hallSettingsController");
const { getLocalDate } = require("../utils/dateHelper");

const formatToDDMMYYYY = (dateString) => {
  if (!dateString) return "";
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split("-");
      return `${day}/${month}/${year}`;
    }
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (err) {
    return dateString;
  }
};


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

    // Use booking tax settings if available, else fall back to global settings
    const tax_enabled = booking.tax_enabled !== null && booking.tax_enabled !== undefined
      ? booking.tax_enabled
      : settings.tax_enabled;

    const tax_percentage = booking.tax_percentage !== null && booking.tax_percentage !== undefined
      ? Number(booking.tax_percentage)
      : settings.tax_percentage;

    const tax_label = booking.tax_label || settings.tax_label || "GST";

    const subtotal = booking.subtotal !== null && booking.subtotal !== undefined
      ? Number(booking.subtotal)
      : Number(booking.total_amount || 0);

    const discount = discount_amount !== undefined ? Number(discount_amount) : Number(booking.discount_amount || 0);
    const taxable_amount = subtotal - discount;

    const tax_amount = tax_enabled
      ? Math.round((taxable_amount * tax_percentage) / 100 * 100) / 100
      : 0;

    const total_amount = taxable_amount + tax_amount;

    const items = line_items || [
      {
        description: booking.event_name || "Hall Booking",
        quantity: 1,
        unit_price: subtotal,
        amount: subtotal,
      },
    ];

    // Amount paid so far
    const amount_paid = (booking.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance_due = total_amount - amount_paid;

    const invoiceData = {
      hall_id,
      booking_id,
      invoice_number: invoiceNumber,
      invoice_date: getLocalDate(),
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
      tax_enabled,
      tax_percentage,
      tax_label,
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

    // Format all dates to DD/MM/YYYY for render display
    inv.invoice_date = formatToDDMMYYYY(inv.invoice_date);
    inv.due_date = formatToDDMMYYYY(inv.due_date);
    inv.event_date = formatToDDMMYYYY(inv.event_date);
    inv.event_end_date = formatToDDMMYYYY(inv.event_end_date);

    // Fetch active subscription, template settings, and bank details from profile
    const today = getLocalDate();
    const [subRes, settingsRes, profileRes] = await Promise.all([
      supabaseAdmin
        .from("hall_subscriptions")
        .select("packages(name, features)")
        .eq("hall_id", hall_id)
        .in("status", ["active", "trial"])
        .gte("end_date", today)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("hall_settings")
        .select("invoice_template")
        .eq("hall_id", hall_id)
        .maybeSingle(),
      supabaseAdmin
        .from("hall_profiles")
        .select("bank_name, account_number, ifsc_code, upi_id")
        .eq("hall_id", hall_id)
        .maybeSingle()
    ]);

    const sub = subRes?.data;
    const packageName = sub?.packages?.name || "";
    const isPremium = packageName.toLowerCase().includes("premium") || 
                      packageName.toLowerCase().includes("deluxe") ||
                      packageName.toLowerCase().includes("standard") || 
                      packageName.toLowerCase().includes("transformation") ||
                      sub?.packages?.features?.invoice_templates ||
                      false;

    let template = (settingsRes?.data?.invoice_template || "classic").toLowerCase();
    if (!isPremium) {
      template = "classic"; // Restrict basic tier users to classic/default template
    }

    const bankDetails = profileRes?.data || {};
    const symbol = inv.currency_symbol || "₹";
    const fmt = (n) => `${symbol}${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

    // Generate UPI URL & QR Code URL if UPI ID exists and there's a balance due
    const upiString = bankDetails.upi_id && inv.balance_due > 0
      ? `upi://pay?pa=${encodeURIComponent(bankDetails.upi_id)}&am=${encodeURIComponent(inv.balance_due)}&tn=${encodeURIComponent(inv.invoice_number)}&pn=${encodeURIComponent(inv.hall_name || "Marriage Hall")}`
      : "";
    const qrCodeUrl = upiString
      ? `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(upiString)}`
      : "";

    let html = "";

    // Render based on selected template
    if (template === "modern") {
      // PREMIUM TEMPLATE 1: MODERN / DIGITAL CAPSULE
      const lineItemsModern = (inv.line_items || [])
        .map(
          (item) => `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 14px 16px; color: #1e293b; font-weight: 500;">${item.description || ""}</td>
            <td style="padding: 14px 16px; text-align: center; color: #64748b;">${item.quantity || 1}</td>
            <td style="padding: 14px 16px; text-align: right; color: #475569; font-family: monospace;">${fmt(item.unit_price)}</td>
            <td style="padding: 14px 16px; text-align: right; color: #0f172a; font-weight: 600; font-family: monospace;">${fmt(item.amount)}</td>
          </tr>`
        )
        .join("");

      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${inv.invoice_number}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
  body { background-color: #ffffff; color: #1e293b; padding: 48px; font-size: 13px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .wrapper { max-width: 800px; margin: 0 auto; }
  .badge { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 9999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid transparent; }
  .badge-paid { background-color: #ecfdf5; color: #059669; border-color: #a7f3d0; }
  .badge-unpaid { background-color: #fef2f2; color: #dc2626; border-color: #fecaca; }
  .badge-partial { background-color: #fffbeb; color: #d97706; border-color: #fde68a; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  th { background-color: #f1f5f9; color: #475569; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 16px; text-align: left; }
  .totals-box { margin-left: auto; width: 300px; margin-top: 24px; padding: 16px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; }
  .totals-row { display: flex; justify-content: space-between; padding: 6px 0; color: #64748b; font-weight: 500; }
  .totals-row.grand { border-top: 1px solid #e2e8f0; margin-top: 8px; padding-top: 12px; color: #0f172a; font-weight: 800; font-size: 15px; }
  .totals-row.balance { color: #6366f1; }
  @media print {
    @page { size: auto; margin: 15mm; }
    body { background-color: #ffffff; padding: 0; }
    .wrapper { max-width: 100%; }
    .wrapper, .info-card, .totals-box, .totals-row, tr { page-break-inside: avoid; }
    table { page-break-inside: auto; }
    thead { display: table-header-group; }
    .brand-footer { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="wrapper">
    <!-- Brand Logo & Header -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px;">
      <div>
        ${inv.hall_logo_url ? `<img src="${inv.hall_logo_url}" alt="Logo" style="height: 56px; max-width: 180px; object-fit: contain; margin-bottom: 12px; display: block; border-radius: 8px;">` : `<div style="height: 48px; width: 48px; background: #0F172A; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 18px; margin-bottom: 12px;">${(inv.hall_name || "H").slice(0,1)}</div>`}
        <h1 style="font-size: 20px; font-weight: 800; color: #0F172A; letter-spacing: -0.02em;">${inv.hall_name || "Hall Workspace"}</h1>
        <p style="color: #64748b; font-size: 12px; margin-top: 4px; line-height: 1.5;">
          ${inv.hall_address ? inv.hall_address : ""}<br>
          ${inv.hall_phone ? `Phone: ${inv.hall_phone}` : ""} ${inv.hall_email ? `• Email: ${inv.hall_email}` : ""}<br>
          ${inv.hall_gstin ? `<strong>GSTIN:</strong> ${inv.hall_gstin}` : ""}
        </p>
      </div>
      <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
        <span class="badge badge-${inv.status}">${inv.status}</span>
        <h2 style="font-size: 28px; font-weight: 800; color: #0F172A; margin-top: 8px; letter-spacing: -1px;">INVOICE</h2>
        <p style="font-size: 12px; color: #64748b; font-weight: 600; font-family: monospace; margin-top: 4px;"># ${inv.invoice_number}</p>
        <div style="margin-top: 16px; font-size: 11px; color: #475569; line-height: 1.6;">
          <strong>Date:</strong> ${inv.invoice_date}<br>
          ${inv.due_date ? `<strong>Due Date:</strong> ${inv.due_date}` : ""}
        </div>
      </div>
    </div>

    <!-- Parties Details cards -->
    <div class="grid-2" style="margin-bottom: 40px;">
      <div class="info-card">
        <h4 style="font-size: 10px; font-weight: 800; text-transform: uppercase; color: #7C3AED; letter-spacing: 1px; margin-bottom: 8px;">Bill To</h4>
        <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">${inv.customer_name || ""}</div>
        <p style="color: #475569; font-size: 11.5px; line-height: 1.6;">
          ${inv.customer_phone ? `Phone: ${inv.customer_phone}<br>` : ""}
          ${inv.customer_email ? `Email: ${inv.customer_email}<br>` : ""}
          ${inv.customer_address || ""}
        </p>
      </div>

      <div class="info-card">
        <h4 style="font-size: 10px; font-weight: 800; text-transform: uppercase; color: #7C3AED; letter-spacing: 1px; margin-bottom: 8px;">Event Specification</h4>
        <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">${inv.event_name || inv.event_type || ""}</div>
        <p style="color: #475569; font-size: 11.5px; line-height: 1.6;">
          <strong>Date:</strong> ${inv.event_date} ${inv.event_end_date && inv.event_end_date !== inv.event_date ? ` to ${inv.event_end_date}` : ""}<br>
          <strong>Category:</strong> ${inv.event_type || "Banquet Setup"}<br>
          <strong>Venue Unit:</strong> ${inv.hall_section || "Main Hall"}
        </p>
      </div>
    </div>

    <!-- Table list -->
    <div style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: #ffffff;">
      <table>
        <thead>
          <tr>
            <th style="padding: 12px 16px;">Item Description</th>
            <th style="padding: 12px 16px; text-align: center;">Qty</th>
            <th style="padding: 12px 16px; text-align: right;">Unit Price</th>
            <th style="padding: 12px 16px; text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${lineItemsModern}
        </tbody>
      </table>
    </div>

    <!-- Bottom Calculations & Bank Transfer Instructions -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-top: 32px;">
      <div style="flex: 1; max-width: 420px; font-size: 11px; color: #64748b; line-height: 1.6; padding-right: 24px;">
        ${inv.notes ? `<div style="background-color: #f8fafc; border-left: 3px solid #0F172A; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 11.5px; color: #1e293b;"><strong>Operational Notes:</strong><br>${inv.notes}</div>` : ""}
        
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 14px 16px; border-radius: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
            <div>
              <strong style="color: #0F172A; text-transform: uppercase; font-size: 9.5px; display: block; margin-bottom: 8px; letter-spacing: 0.5px;">Bank Transfer / Payment Instructions</strong>
              ${bankDetails.bank_name ? `<strong>Bank Name:</strong> ${bankDetails.bank_name}<br>` : ""}
              ${bankDetails.account_number ? `<strong>Account Number:</strong> ${bankDetails.account_number}<br>` : ""}
              ${bankDetails.ifsc_code ? `<strong>IFSC Code:</strong> ${bankDetails.ifsc_code}<br>` : ""}
              ${bankDetails.upi_id ? `<strong>UPI ID:</strong> <span style="font-family: monospace; font-weight: 600; color: #0f172a;">${bankDetails.upi_id}</span>` : ""}
              ${!bankDetails.bank_name && !bankDetails.upi_id ? `<em style="color: #94a3b8;">Contact venue managers for payment remittance details.</em>` : ""}
            </div>
            ${qrCodeUrl ? `
            <div style="text-align: center; border-left: 1px solid #e2e8f0; padding-left: 16px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;">
              <img src="${qrCodeUrl}" alt="UPI Scan to Pay" style="width: 90px; height: 90px; display: block;" />
              <span style="font-size: 9px; font-weight: 700; color: #6366f1; margin-top: 6px; letter-spacing: 0.5px; text-transform: uppercase;">Scan to Pay</span>
            </div>
            ` : ""}
          </div>
        </div>
      </div>
      
      <div class="totals-box">
        <div class="totals-row"><span>Subtotal</span><span style="font-family: monospace;">${fmt(inv.subtotal)}</span></div>
        ${inv.discount_amount ? `<div class="totals-row" style="color: #dc2626;"><span>Discount</span><span style="font-family: monospace;">- ${fmt(inv.discount_amount)}</span></div>` : ""}
        
        ${inv.tax_enabled ? (inv.tax_label && inv.tax_label.toUpperCase() === "GST" ? `
          <div class="totals-row"><span>CGST (${inv.tax_percentage / 2}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount / 2)}</span></div>
          <div class="totals-row"><span>SGST (${inv.tax_percentage / 2}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount / 2)}</span></div>
        ` : `
          <div class="totals-row"><span>${inv.tax_label || "Tax"} (${inv.tax_percentage}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount)}</span></div>
        `) : ""}
        
        <div class="totals-row grand"><span>Total</span><span style="font-family: monospace;">${fmt(inv.total_amount)}</span></div>
        ${inv.amount_paid > 0 ? `<div class="totals-row" style="color: #059669; font-size: 11.5px; border-top: 1px dashed #e2e8f0; margin-top: 6px; padding-top: 8px;"><span>Amount Paid</span><span style="font-family: monospace;">- ${fmt(inv.amount_paid)}</span></div>` : ""}
        <div class="totals-row grand balance"><span>Balance Due</span><span style="font-family: monospace;">${fmt(inv.balance_due)}</span></div>
      </div>
    </div>

    <!-- Premium Brand Footer -->
    <div class="brand-footer" style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; color: #94a3b8; font-weight: 500;">
      <span>Powered by <strong style="color: #475569;">Infovex Halls</strong> — India's First Dedicated Venue CRM</span>
      <span>by <strong style="color: #475569;">Infovex Technologies</strong></span>
    </div>
  </div>
</body>
</html>`;

    } else if (template === "elegant") {
      // PREMIUM TEMPLATE 2: ELEGANT / LUXURY WEDDING GOLD & NAVY
      const lineItemsElegant = (inv.line_items || [])
        .map(
          (item) => `
          <tr style="border-bottom: 1px double #e2e8f0;">
            <td style="padding: 12px 8px; color: #0F172A; font-family: 'Montserrat', sans-serif; font-size: 12px; font-weight: 600;">${item.description || ""}</td>
            <td style="padding: 12px 8px; text-align: center; color: #5c6f84; font-family: 'Montserrat', sans-serif;">${item.quantity || 1}</td>
            <td style="padding: 12px 8px; text-align: right; color: #5c6f84; font-family: 'Montserrat', sans-serif;">${fmt(item.unit_price)}</td>
            <td style="padding: 12px 8px; text-align: right; color: #0F172A; font-weight: 750; font-family: 'Montserrat', sans-serif;">${fmt(item.amount)}</td>
          </tr>`
        )
        .join("");

      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${inv.invoice_number}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background-color: #ffffff; color: #2d3748; padding: 50px; font-family: 'Montserrat', sans-serif; font-size: 12.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .wrapper { max-width: 800px; margin: 0 auto; border: 1px solid #d4af37; padding: 40px; position: relative; background: #fffcf9; }
  .wrapper::before { content: ""; position: absolute; top: 8px; left: 8px; right: 8px; bottom: 8px; border: 1px solid #e0c878; pointer-events: none; }
  .gold-divider { height: 1px; background: linear-gradient(to right, transparent, #d4af37, transparent); margin: 24px 0; }
  .elegant-title { font-family: 'Playfair Display', serif; font-size: 32px; font-weight: 700; color: #0F172A; letter-spacing: 2px; text-transform: uppercase; }
  .sub-title { font-family: 'Playfair Display', serif; font-size: 18px; color: #b89230; font-style: italic; margin-top: 4px; }
  .section-heading { font-family: 'Playfair Display', serif; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #b89230; letter-spacing: 1.5px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { border-bottom: 2px solid #b89230; border-top: 1px solid #e2e8f0; color: #0F172A; font-family: 'Playfair Display', serif; font-weight: 700; font-size: 12px; padding: 12px 8px; text-align: left; background: transparent; }
  .totals-elegant { margin-left: auto; width: 270px; margin-top: 24px; font-size: 12.5px; }
  .totals-row-el { display: flex; justify-content: space-between; padding: 6px 0; color: #4a5568; }
  .totals-row-el.bold { font-weight: 700; color: #0F172A; }
  .totals-row-el.grand-el { border-top: 1px solid #b89230; border-bottom: 1px solid #b89230; padding: 10px 0; margin-top: 8px; font-family: 'Playfair Display', serif; font-size: 16px; font-weight: 700; color: #0F172A; }
  .status-label { font-family: 'Playfair Display', serif; font-style: italic; color: #b89230; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  @media print {
    @page { size: auto; margin: 15mm; }
    body { background-color: #ffffff; padding: 0; }
    .wrapper { border: none; padding: 20px; max-width: 100%; }
    .wrapper::before { display: none; }
    .totals-elegant, .totals-row-el, tr, .gold-divider { page-break-inside: avoid; }
    table { page-break-inside: auto; }
    thead { display: table-header-group; }
  }
</style>
</head>
<body>
  <div class="wrapper">
    
    <!-- Decorative Header Block -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div>
        ${inv.hall_logo_url ? `<img src="${inv.hall_logo_url}" alt="Logo" style="height: 60px; max-width: 200px; object-fit: contain; margin-bottom: 12px; display: block;">` : ""}
        <div class="elegant-title">${inv.hall_name || "Marriage Hall"}</div>
        <div class="sub-title">Grand Wedding & Banquets Venue</div>
        <p style="color: #5c6f84; font-size: 11px; margin-top: 8px; line-height: 1.6;">
          ${inv.hall_address ? inv.hall_address : ""}<br>
          ${inv.hall_phone ? `Call: ${inv.hall_phone}` : ""} • ${inv.hall_email ? `Email: ${inv.hall_email}` : ""}<br>
          ${inv.hall_gstin ? `<strong>GSTIN:</strong> ${inv.hall_gstin}` : ""}
        </p>
      </div>
      <div style="text-align: right;">
        <h2 style="font-family: 'Playfair Display', serif; font-size: 26px; font-weight: 400; color: #0F172A; letter-spacing: 2px;">RECEIPT INVOICE</h2>
        <p style="font-family: 'Playfair Display', serif; color: #b89230; font-size: 13px; font-weight: 700; margin-top: 4px;"># ${inv.invoice_number}</p>
        
        <div style="margin-top: 20px; font-size: 11px; color: #5c6f84; line-height: 1.5; font-family: 'Montserrat', sans-serif;">
          <strong>Invoice Date:</strong> ${inv.invoice_date}<br>
          ${inv.due_date ? `<strong>Due Date:</strong> ${inv.due_date}<br>` : ""}
          <strong>Payment Status:</strong> <span class="status-label">${inv.status}</span>
        </div>
      </div>
    </div>

    <div class="gold-divider"></div>

    <!-- Client Details Section -->
    <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 24px;">
      <div>
        <div class="section-heading">Prepared for Guest</div>
        <div style="font-size: 14px; font-weight: 700; color: #0F172A; margin-bottom: 4px; font-family: 'Playfair Display', serif;">${inv.customer_name || ""}</div>
        <p style="color: #4a5568; font-size: 11px; line-height: 1.6;">
          ${inv.customer_phone ? `Phone: ${inv.customer_phone}<br>` : ""}
          ${inv.customer_email ? `Email: ${inv.customer_email}<br>` : ""}
          ${inv.customer_address || ""}
        </p>
      </div>
      <div>
        <div class="section-heading">Event Particulars</div>
        <div style="font-size: 13px; font-weight: 700; color: #0F172A; margin-bottom: 4px; font-family: 'Playfair Display', serif;">${inv.event_name || inv.event_type || ""}</div>
        <p style="color: #4a5568; font-size: 11px; line-height: 1.6;">
          <strong>Date:</strong> ${inv.event_date} ${inv.event_end_date && inv.event_end_date !== inv.event_date ? ` to ${inv.event_end_date}` : ""}<br>
          <strong>Category:</strong> ${inv.event_type || "Wedding Reception"}<br>
          <strong>Venue Unit:</strong> ${inv.hall_section || "Grand A/C Hall"}
        </p>
      </div>
    </div>

    <!-- Line Items Table -->
    <table style="margin-top: 32px;">
      <thead>
        <tr>
          <th>Description of Services & Venue Hires</th>
          <th style="text-align: center; width: 60px;">Qty</th>
          <th style="text-align: right; width: 110px;">Unit Rate</th>
          <th style="text-align: right; width: 120px;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsElegant}
      </tbody>
    </table>

    <!-- Bottom Calculations section & Remittance Details -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-top: 30px;">
      <div style="flex: 1; font-size: 11.5px; color: #4a5568; line-height: 1.6; padding-right: 32px;">
        ${inv.notes ? `<div style="font-style: italic; font-family: 'Playfair Display', serif; color: #718096; margin-bottom: 16px;">* Note: ${inv.notes}</div>` : ""}
        
        <div style="border: 1px solid #e0c878; padding: 14px 16px; background: #fffdfc; font-size: 11px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
            <div>
              <strong style="color: #b89230; text-transform: uppercase; font-family: 'Playfair Display', serif; font-size: 9.5px; display: block; margin-bottom: 8px; letter-spacing: 1px;">Bank Details / Remittance Instructions</strong>
              ${bankDetails.bank_name ? `<strong>Banker:</strong> ${bankDetails.bank_name}<br>` : ""}
              ${bankDetails.account_number ? `<strong>Account Number:</strong> ${bankDetails.account_number}<br>` : ""}
              ${bankDetails.ifsc_code ? `<strong>IFSC Code:</strong> ${bankDetails.ifsc_code}<br>` : ""}
              ${bankDetails.upi_id ? `<strong>UPI Address:</strong> <span style="font-family: monospace; color: #0F172A; font-weight: 600;">${bankDetails.upi_id}</span>` : ""}
              ${!bankDetails.bank_name && !bankDetails.upi_id ? `<em style="color: #a0aec0;">Contact venue operators for bank transfer details.</em>` : ""}
            </div>
            ${qrCodeUrl ? `
            <div style="text-align: center; border-left: 1px solid #e0c878; padding-left: 16px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;">
              <img src="${qrCodeUrl}" alt="UPI Scan to Pay" style="width: 90px; height: 90px; display: block;" />
              <span style="font-family: 'Playfair Display', serif; font-size: 9px; font-weight: 700; color: #b89230; margin-top: 6px; letter-spacing: 0.5px; text-transform: uppercase;">Scan to Pay</span>
            </div>
            ` : ""}
          </div>
        </div>
      </div>
      
      <div class="totals-elegant">
        <div class="totals-row-el"><span>Subtotal</span><span>${fmt(inv.subtotal)}</span></div>
        ${inv.discount_amount ? `<div class="totals-row-el" style="color: #c53030;"><span>Adjusted Discount</span><span>- ${fmt(inv.discount_amount)}</span></div>` : ""}
        
        ${inv.tax_enabled ? (inv.tax_label && inv.tax_label.toUpperCase() === "GST" ? `
          <div class="totals-row-el"><span>CGST (${inv.tax_percentage / 2}%)</span><span>${fmt(inv.tax_amount / 2)}</span></div>
          <div class="totals-row-el"><span>SGST (${inv.tax_percentage / 2}%)</span><span>${fmt(inv.tax_amount / 2)}</span></div>
        ` : `
          <div class="totals-row-el"><span>${inv.tax_label || "Tax"} (${inv.tax_percentage}%)</span><span>${fmt(inv.tax_amount)}</span></div>
        `) : ""}
        
        <div class="totals-row-el grand-el"><span>Total Charge</span><span>${fmt(inv.total_amount)}</span></div>
        ${inv.amount_paid > 0 ? `<div class="totals-row-el bold" style="color: #276749; font-size: 11.5px; padding-top: 6px;"><span>Total Receipts logged</span><span>- ${fmt(inv.amount_paid)}</span></div>` : ""}
        <div class="totals-row-el grand-el" style="color: #b89230;"><span>Pending Balance</span><span>${fmt(inv.balance_due)}</span></div>
      </div>
    </div>

    <!-- Ornate Signature Lines -->
    <div style="display: flex; justify-content: space-between; margin-top: 60px; font-size: 10px; font-family: 'Playfair Display', serif; text-transform: uppercase; letter-spacing: 1px;">
      <div style="border-top: 1px solid #d4af37; width: 190px; text-align: center; padding-top: 8px; color: #0F172A;">Authorized Representative</div>
      <div style="border-top: 1px solid #d4af37; width: 190px; text-align: center; padding-top: 8px; color: #0F172A;">Client / Payer Signature</div>
    </div>

    <!-- Brand Footer -->
    <div class="brand-footer" style="margin-top: 50px; padding-top: 16px; border-top: 1px solid #d4af37; display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; color: #b89230; font-family: 'Montserrat', sans-serif; letter-spacing: 0.8px; text-transform: uppercase;">
      <span>Powered by <strong>Infovex Halls</strong> — India's First dedicated Venue CRM</span>
      <span>by <strong>Infovex Technologies</strong></span>
    </div>
  </div>
</body>
</html>`;

    } else if (template === "minimalist") {
      // PREMIUM TEMPLATE 3: MINIMALIST / ULTRA-CLEAN MONOCHROME
      const lineItemsMinimalist = (inv.line_items || [])
        .map(
          (item) => `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 12px 0; color: #111; font-weight: 500;">${item.description || ""}</td>
            <td style="padding: 12px 0; text-align: center; color: #555;">${item.quantity || 1}</td>
            <td style="padding: 12px 0; text-align: right; color: #555; font-family: monospace;">${fmt(item.unit_price)}</td>
            <td style="padding: 12px 0; text-align: right; color: #111; font-weight: 700; font-family: monospace;">${fmt(item.amount)}</td>
          </tr>`
        )
        .join("");

      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${inv.invoice_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background-color: #ffffff; color: #333333; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; font-size: 12px; }
  .container { max-width: 760px; margin: 0 auto; }
  .divider-thin { border: none; border-top: 1px solid #000000; margin: 20px 0; }
  .divider-light { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { border-bottom: 1px solid #000000; color: #000000; font-weight: 700; font-size: 11px; text-transform: uppercase; padding: 10px 0; text-align: left; }
  .totals-min { margin-left: auto; width: 250px; margin-top: 16px; }
  .totals-row-min { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals-row-min.bold { font-weight: 700; color: #000000; border-top: 1px solid #000; margin-top: 4px; padding-top: 8px; }
  .status-unpaid-min { border: 1px solid #e11d48; color: #e11d48; padding: 2px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .status-paid-min { border: 1px solid #059669; color: #059669; padding: 2px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .status-partial-min { border: 1px solid #d97706; color: #d97706; padding: 2px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  @media print {
    @page { size: auto; margin: 15mm; }
    body { background-color: #ffffff; padding: 0; }
    .container { max-width: 100%; }
    .totals-min, .totals-row-min, tr, .divider-thin, .divider-light { page-break-inside: avoid; }
    table { page-break-inside: auto; }
    thead { display: table-header-group; }
  }
</style>
</head>
<body>
  <div class="container">
    
    <!-- Header layout -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div>
        <h1 style="font-size: 20px; font-weight: 700; color: #000000; letter-spacing: -0.5px;">${inv.hall_name || "VENUE"}</h1>
        <p style="color: #666; font-size: 11px; margin-top: 4px; line-height: 1.5; font-family: monospace;">
          ${inv.hall_address ? inv.hall_address : ""}<br>
          ${inv.hall_phone ? `P: ${inv.hall_phone}` : ""} ${inv.hall_email ? `• E: ${inv.hall_email}` : ""}<br>
          ${inv.hall_gstin ? `GSTIN: ${inv.hall_gstin}` : ""}
        </p>
      </div>
      <div style="text-align: right;">
        <h2 style="font-size: 20px; font-weight: 300; letter-spacing: 1px; color: #000000; margin-bottom: 6px;">INVOICE</h2>
        <p style="font-family: monospace; font-size: 12px; font-weight: 700; margin-bottom: 8px;"># ${inv.invoice_number}</p>
        <span class="status-${inv.status}-min">${inv.status}</span>
      </div>
    </div>

    <div class="divider-thin"></div>

    <div style="display: flex; justify-content: space-between; font-size: 11px; line-height: 1.6;">
      <div>
        <div style="font-weight: 700; text-transform: uppercase; font-size: 9px; color: #888; margin-bottom: 4px;">Bill To</div>
        <strong>${inv.customer_name || ""}</strong><br>
        ${inv.customer_phone ? `Phone: ${inv.customer_phone}<br>` : ""}
        ${inv.customer_email ? `Email: ${inv.customer_email}<br>` : ""}
        ${inv.customer_address || ""}
      </div>
      <div style="text-align: right;">
        <div style="font-weight: 700; text-transform: uppercase; font-size: 9px; color: #888; margin-bottom: 4px;">Metadata</div>
        <strong>Event:</strong> ${inv.event_name || inv.event_type || ""}<br>
        <strong>Schedules:</strong> ${inv.event_date}<br>
        <strong>Created:</strong> ${inv.invoice_date}
      </div>
    </div>

    <!-- Table -->
    <table>
      <thead>
        <tr>
          <th style="text-align: left;">Description</th>
          <th style="text-align: center; width: 60px;">Qty</th>
          <th style="text-align: right; width: 100px;">Price</th>
          <th style="text-align: right; width: 110px;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsMinimalist}
      </tbody>
    </table>

    <!-- Calculations & Bank Details -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-top: 24px;">
      <div style="flex: 1; font-size: 11px; color: #333; font-family: monospace; padding-right: 40px; line-height: 1.5;">
        ${inv.notes ? `NOTE: ${inv.notes}<br><br>` : ""}
        <div style="border-top: 1px solid #000; padding-top: 12px; font-size: 10.5px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
            <div>
              <strong style="color: #000; text-transform: uppercase; display: block; margin-bottom: 6px; font-weight: 700;">PAYMENT METHODS</strong>
              ${bankDetails.bank_name ? `Bank: ${bankDetails.bank_name}<br>` : ""}
              ${bankDetails.account_number ? `Account: ${bankDetails.account_number}<br>` : ""}
              ${bankDetails.ifsc_code ? `IFSC: ${bankDetails.ifsc_code}<br>` : ""}
              ${bankDetails.upi_id ? `UPI: ${bankDetails.upi_id}` : ""}
              ${!bankDetails.bank_name && !bankDetails.upi_id ? `Contact venue representative for payment transfer details.` : ""}
            </div>
            ${qrCodeUrl ? `
            <div style="text-align: center; border-left: 1px solid #000; padding-left: 16px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;">
              <img src="${qrCodeUrl}" alt="UPI Scan to Pay" style="width: 90px; height: 90px; display: block; filter: grayscale(100%);" />
              <span style="font-size: 9px; font-weight: 700; color: #000; margin-top: 6px; letter-spacing: 0.5px; text-transform: uppercase; font-family: monospace;">SCAN TO PAY</span>
            </div>
            ` : ""}
          </div>
        </div>
      </div>
      
      <div class="totals-min">
        <div class="totals-row-min"><span>Subtotal</span><span style="font-family: monospace;">${fmt(inv.subtotal)}</span></div>
        ${inv.discount_amount ? `<div class="totals-row-min" style="color: #e11d48;"><span>Discount</span><span style="font-family: monospace;">- ${fmt(inv.discount_amount)}</span></div>` : ""}
        
        ${inv.tax_enabled ? (inv.tax_label && inv.tax_label.toUpperCase() === "GST" ? `
          <div class="totals-row-min"><span>CGST (${inv.tax_percentage / 2}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount / 2)}</span></div>
          <div class="totals-row-min"><span>SGST (${inv.tax_percentage / 2}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount / 2)}</span></div>
        ` : `
          <div class="totals-row-min"><span>${inv.tax_label || "Tax"} (${inv.tax_percentage}%)</span><span style="font-family: monospace;">${fmt(inv.tax_amount)}</span></div>
        `) : ""}
        
        <div class="totals-row-min bold"><span>Total</span><span style="font-family: monospace;">${fmt(inv.total_amount)}</span></div>
        ${inv.amount_paid > 0 ? `<div class="totals-row-min" style="font-size: 11px; color: #059669; padding-top: 4px;"><span>Payments Received</span><span style="font-family: monospace;">- ${fmt(inv.amount_paid)}</span></div>` : ""}
        <div class="totals-row-min bold" style="border-top: 1px dashed #ccc; font-size: 13px;"><span>Balance Due</span><span style="font-family: monospace;">${fmt(inv.balance_due)}</span></div>
      </div>
    </div>

    <div class="divider-light" style="margin-top: 60px;"></div>

    <!-- Brand Footer -->
    <div class="brand-footer" style="display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: #999999; font-family: monospace;">
      <span>Powered by Infovex Halls — India's First dedicated Venue CRM</span>
      <span>by Infovex Technologies</span>
    </div>
  </div>
</body>
</html>`;

    } else {
      // DEFAULT / CLASSIC TEMPLATE
      const lineItemsClassic = (inv.line_items || [])
        .map(
          (item) => `
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f0f0f0;">${item.description || ""}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f0f0f0; text-align:center">${item.quantity || 1}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f0f0f0; text-align:right">${fmt(item.unit_price)}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f0f0f0; text-align:right">${fmt(item.amount)}</td>
          </tr>`
        )
        .join("");

      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${inv.invoice_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #333; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .hall-name { font-size: 22px; font-weight: 700; color: #0F172A; }
  .hall-details { font-size: 12px; color: #666; margin-top: 4px; line-height: 1.6; }
  .invoice-meta { text-align: right; }
  .invoice-meta h2 { font-size: 28px; color: #0F172A; letter-spacing: 1px; }
  .invoice-meta p { font-size: 12px; color: #666; margin-top: 4px; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .party-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888; margin-bottom: 6px; letter-spacing: 0.5px; }
  .party-name { font-size: 15px; font-weight: 600; color: #1a1a1a; }
  .party-detail { font-size: 12px; color: #666; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  thead th { background: #f8fafc; padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
  .totals { margin-left: auto; width: 280px; }
  .totals table { font-size: 13px; width: 100%; }
  .totals td { padding: 5px 8px; }
  .totals .label { color: #666; }
  .totals .amount { text-align: right; font-weight: 500; }
  .total-row td { font-size: 15px; font-weight: 700; border-top: 2px solid #0F172A; padding-top: 8px; color: #0F172A; }
  .balance-row td { color: #7C3AED; font-size: 16px; font-weight: 700; }
  .paid-row td { color: #16a34a; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 600; border: 1px solid transparent; text-transform: uppercase; }
  .status-paid { background: #dcfce7; color: #16a34a; border-color: #bbf7d0; }
  .status-unpaid { background: #fee2e2; color: #dc2626; border-color: #fecaca; }
  .status-partial { background: #fef3c7; color: #d97706; border-color: #fde68a; }
  .footer { margin-top: 40px; font-size: 12px; color: #888; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  @media print {
    @page { size: auto; margin: 15mm; }
    body { background-color: #ffffff; padding: 0; }
    .totals, tr, .divider { page-break-inside: avoid; }
    table { page-break-inside: auto; }
    thead th { background: #f8fafc !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      ${inv.hall_logo_url ? `<img src="${inv.hall_logo_url}" alt="Logo" style="height:52px;margin-bottom:8px;display:block;object-fit:contain;">` : ""}
      <div class="hall-name">${inv.hall_name || "Venue Panel"}</div>
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
      <span class="status-badge status-${inv.status}">${inv.status}</span>
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
        <th style="text-align:center; width: 60px;">Qty</th>
        <th style="text-align:right; width: 110px;">Unit Price</th>
        <th style="text-align:right; width: 120px;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsClassic}
    </tbody>
  </table>

  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-top: 24px;">
    <div style="flex: 1; font-size: 11px; color: #555; line-height: 1.6; padding-right: 32px;">
      ${inv.notes ? `<div style="background: #f8fafc; border-left: 3px solid #0F172A; padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; color: #333;"><strong>Notes:</strong><br>${inv.notes}</div>` : ""}
      
      <div style="border: 1px solid #e5e7eb; border-radius: 4px; padding: 10px 14px; background: #fafafa;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
          <div>
            <strong style="color: #0F172A; text-transform: uppercase; font-size: 9.5px; display: block; margin-bottom: 6px;">Bank Details / Remittance</strong>
            ${bankDetails.bank_name ? `<strong>Bank Name:</strong> ${bankDetails.bank_name}<br>` : ""}
            ${bankDetails.account_number ? `<strong>Account Number:</strong> ${bankDetails.account_number}<br>` : ""}
            ${bankDetails.ifsc_code ? `<strong>IFSC Code:</strong> ${bankDetails.ifsc_code}<br>` : ""}
            ${bankDetails.upi_id ? `<strong>UPI ID:</strong> <span style="font-family: monospace;">${bankDetails.upi_id}</span>` : ""}
            ${!bankDetails.bank_name && !bankDetails.upi_id ? `<em>Contact venue operators for bank payment instructions.</em>` : ""}
          </div>
          ${qrCodeUrl ? `
          <div style="text-align: center; border-left: 1px solid #e5e7eb; padding-left: 16px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;">
            <img src="${qrCodeUrl}" alt="UPI Scan to Pay" style="width: 90px; height: 90px; display: block;" />
            <span style="font-size: 9px; font-weight: 700; color: #0F172A; margin-top: 6px; letter-spacing: 0.5px; text-transform: uppercase;">Scan to Pay</span>
          </div>
          ` : ""}
        </div>
      </div>
    </div>
    
    <div class="totals">
      <table>
        <tr><td class="label">Subtotal</td><td class="amount">${fmt(inv.subtotal)}</td></tr>
        ${inv.discount_amount ? `<tr><td class="label">Discount</td><td class="amount">- ${fmt(inv.discount_amount)}</td></tr>` : ""}
        
        ${inv.tax_enabled ? (inv.tax_label && inv.tax_label.toUpperCase() === "GST" ? `
          <tr><td class="label">CGST (${inv.tax_percentage / 2}%)</td><td class="amount">${fmt(inv.tax_amount / 2)}</td></tr>
          <tr><td class="label">SGST (${inv.tax_percentage / 2}%)</td><td class="amount">${fmt(inv.tax_amount / 2)}</td></tr>
        ` : `
          <tr><td class="label">${inv.tax_label || "Tax"} (${inv.tax_percentage}%)</td><td class="amount">${fmt(inv.tax_amount)}</td></tr>
        `) : ""}
        
        <tr class="total-row"><td>Total</td><td class="amount">${fmt(inv.total_amount)}</td></tr>
        ${inv.amount_paid > 0 ? `<tr class="paid-row"><td class="label">Amount Paid</td><td class="amount">- ${fmt(inv.amount_paid)}</td></tr>` : ""}
        <tr class="balance-row"><td>Balance Due</td><td class="amount">${fmt(inv.balance_due)}</td></tr>
      </table>
    </div>
  </div>

  <!-- Brand Footer -->
  <div class="brand-footer" style="margin-top: 50px; padding-top: 16px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; font-weight: 500;">
    <span>Powered by <strong style="color: #64748b;">Infovex Halls</strong> — India's First dedicated Venue CRM</span>
    <span>by <strong style="color: #64748b;">Infovex Technologies</strong></span>
  </div>
</body>
</html>`;
    }

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

/* ============================================================
   DELETE INVOICE
   ============================================================ */
const deleteInvoice = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { id } = req.params;

    // Check if invoice exists and belongs to this hall
    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("id, invoice_number")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found or does not belong to your hall" });
    }

    // Delete invoice
    const { error } = await supabaseAdmin
      .from("invoices")
      .delete()
      .eq("id", id)
      .eq("hall_id", hall_id);

    if (error) throw error;

    res.json({ message: "Invoice successfully deleted", invoice_number: invoice.invoice_number });
  } catch (err) {
    console.error("deleteInvoice error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const exportGstr1Report = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { from_date, to_date } = req.query;

    if (!from_date || !to_date) {
      return res.status(400).json({ message: "from_date and to_date are required" });
    }

    const { data: invoices, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("hall_id", hall_id)
      .gte("invoice_date", from_date)
      .lte("invoice_date", to_date)
      .order("invoice_date", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    let csvContent = "Invoice Number,Invoice Date,Customer Name,Customer GSTIN,Subtotal,CGST Rate %,CGST Amount,SGST Rate %,SGST Amount,Total Invoice Value,Place of Supply,Status\n";

    (invoices || []).forEach(inv => {
      const invoiceNo = inv.invoice_number || "";
      const date = formatToDDMMYYYY(inv.invoice_date);
      const customerName = (inv.customer_name || "").replace(/"/g, '""');
      const customerGstin = inv.customer_gstin || "URP";
      const subtotalVal = inv.subtotal || 0;
      const cgstRate = inv.tax_enabled ? (inv.tax_percentage / 2) : 0;
      const cgstAmt = inv.tax_enabled ? (inv.tax_amount / 2) : 0;
      const sgstRate = inv.tax_enabled ? (inv.tax_percentage / 2) : 0;
      const sgstAmt = inv.tax_enabled ? (inv.tax_amount / 2) : 0;
      const totalVal = inv.total_amount || 0;
      const placeOfSupply = inv.customer_address ? (inv.customer_address.split(",").pop().trim()) : "Local";
      const status = inv.status || "";

      csvContent += `"${invoiceNo}","${date}","${customerName}","${customerGstin}",${subtotalVal},${cgstRate}%,${cgstAmt},${sgstRate}%,${sgstAmt},${totalVal},"${placeOfSupply}","${status}"\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=GSTR1_Report_${from_date}_to_${to_date}.csv`);
    res.status(200).send(csvContent);
  } catch (err) {
    console.error("exportGstr1Report error:", err);
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
  deleteInvoice,
  exportGstr1Report,
};