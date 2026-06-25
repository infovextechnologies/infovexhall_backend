const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

/* Get subscription for a hall */
const getSubscription = async (req, res) => {
  const hall_id = req.params.hall_id || req.user.hall_id;

  const { data, error } = await supabaseAdmin
    .from("hall_subscriptions")
    .select(`*, packages(name, price, billing_cycle, features, max_users, max_bookings, setup_fee)`)
    .eq("hall_id", hall_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ message: error.message });
  if (!data) return res.status(404).json({ message: "No subscription found" });

  const today = new Date().toISOString().split("T")[0];
  if ((data.status === "active" || data.status === "trial") && data.end_date < today) {
    data.status = "expired";
  }

  res.json(data);
};

/* Renew/extend subscription */
const renewSubscription = async (req, res) => {
  const { hall_id } = req.params;
  const { months = 1 } = req.body;

  const { data: sub } = await supabaseAdmin
    .from("hall_subscriptions")
    .select("id, end_date")
    .eq("hall_id", hall_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub) return res.status(404).json({ message: "Subscription not found" });

  const currentEnd = new Date(sub.end_date);
  currentEnd.setMonth(currentEnd.getMonth() + months);

  const { error } = await supabaseAdmin
    .from("hall_subscriptions")
    .update({
      end_date: currentEnd.toISOString().split("T")[0],
      status: "active",
      payment_status: "paid",
    })
    .eq("id", sub.id);

  if (error) return res.status(500).json({ message: error.message });

  // Reactivate hall if suspended
  await supabaseAdmin
    .from("marriage_halls")
    .update({ status: "active" })
    .eq("id", hall_id);

  res.json({ message: `Subscription renewed for ${months} month(s)`, new_end_date: currentEnd });
};

/* Change package */
const changePackage = async (req, res) => {
  const { hall_id } = req.params;
  const { package_id } = req.body;

  if (!package_id) return res.status(400).json({ message: "package_id required" });

  const { error } = await supabaseAdmin
    .from("hall_subscriptions")
    .update({ package_id })
    .eq("hall_id", hall_id)
    .eq("status", "active");

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: "Package changed successfully" });
};

/* Request package change / renewal (Owner submission) */
const requestSubscriptionChange = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { package_id, request_type = "upgrade", notes = "" } = req.body;

    let packageName = "Renewal";
    if (package_id) {
      const { data: pkg } = await supabaseAdmin
        .from("packages")
        .select("name")
        .eq("id", package_id)
        .maybeSingle();
      if (pkg) packageName = pkg.name;
    }

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "subscription.request_change",
      entity_type: "subscription",
      description: `Requested plan ${request_type} to ${packageName}. Notes: ${notes}`,
      metadata: { package_id, request_type, notes },
    });

    // Create notification for operators
    await supabaseAdmin.from("notifications").insert([{
      hall_id,
      type: "subscription_request",
      title: "Plan Request Submitted",
      message: `Request for ${request_type} to ${packageName} has been logged. Support will contact you shortly.`,
      entity_type: "subscription",
      is_read: false,
    }]);

    res.json({ message: "Subscription request submitted successfully. Our team will contact you shortly." });
  } catch (err) {
    console.error("requestSubscriptionChange error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Submit subscription payment (Owner remittance submission) */
const submitSubscriptionPayment = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { package_id, amount, payment_method, transaction_ref_no, notes = "" } = req.body;

    if (!package_id || !amount || !payment_method || !transaction_ref_no) {
      return res.status(400).json({ message: "Missing required billing details" });
    }

    if (payment_method !== "upi" && payment_method !== "bank_transfer") {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    // Validate UTR (must be exactly 12 digits numeric)
    const utrRegex = /^\d{12}$/;
    if (!utrRegex.test(transaction_ref_no)) {
      return res.status(400).json({ message: "Reference number (UTR) must be exactly 12 numeric digits" });
    }

    // Check if UTR is already approved
    const { data: existingUtr } = await supabaseAdmin
      .from("subscription_payments")
      .select("id")
      .eq("transaction_ref_no", transaction_ref_no)
      .eq("status", "approved")
      .maybeSingle();

    if (existingUtr) {
      return res.status(400).json({ message: "This transaction reference number (UTR) has already been approved and credited." });
    }

    // Insert subscription payment log
    const { data: newPayment, error } = await supabaseAdmin
      .from("subscription_payments")
      .insert([{
        hall_id,
        package_id,
        amount: parseFloat(amount),
        payment_method,
        transaction_ref_no,
        status: "pending",
        notes
      }])
      .select()
      .single();

    if (error) {
      console.error("submitSubscriptionPayment insert error:", error);
      return res.status(500).json({ message: error.message });
    }

    // Create activity log
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "subscription.payment_submitted",
      entity_type: "subscription_payment",
      description: `Submitted payment of ₹${amount} via ${payment_method.toUpperCase()} (UTR: ${transaction_ref_no}) for verification.`,
      metadata: { payment_id: newPayment.id, amount, transaction_ref_no, payment_method }
    });

    // Create system notification for Super Admins (hall_id: null)
    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name")
      .eq("id", hall_id)
      .maybeSingle();

    const hallName = hall?.hall_name || "A venue";

    await supabaseAdmin.from("notifications").insert([{
      hall_id: null, // super admin alert
      type: "subscription_payment_pending",
      title: "Pending Subscription Payment",
      message: `${hallName} submitted ₹${amount} (UTR: ${transaction_ref_no}) for verification.`,
      entity_type: "subscription_payment",
      entity_id: newPayment.id,
      is_read: false
    }]);

    res.json({ message: "Remittance details submitted successfully. Verification will complete within 2-4 business hours." });
  } catch (err) {
    console.error("submitSubscriptionPayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Get payment history for owner */
const getSubscriptionPaymentHistory = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { data, error } = await supabaseAdmin
      .from("subscription_payments")
      .select("*, packages(name, setup_fee)")
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("getSubscriptionPaymentHistory error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* Render subscription invoice HTML */
const getSubscriptionInvoiceHtml = async (req, res) => {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user && req.user.role === "super_admin";
    const userHallId = req.user.hall_id;

    // 1. Fetch payment details
    const { data: payment, error: pmtErr } = await supabaseAdmin
      .from("subscription_payments")
      .select(`
        *,
        packages(name, billing_cycle),
        marriage_halls(hall_name, owner_name)
      `)
      .eq("id", id)
      .maybeSingle();

    if (pmtErr || !payment) {
      return res.status(404).send("<h3>SaaS Invoice Not Found</h3>");
    }

    // Security check: if not super admin, check if payment belongs to this owner's hall
    if (!isSuperAdmin && payment.hall_id !== userHallId) {
      return res.status(403).send("<h3>Access Denied</h3>");
    }

    // Fetch hall profile details
    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("*")
      .eq("hall_id", payment.hall_id)
      .maybeSingle();

    // Fetch admin settings for company details
    const { data: settings } = await supabaseAdmin
      .from("admin_settings")
      .select("*")
      .limit(1)
      .maybeSingle();

    const companyName = "Infovex Halls";
    const companyGstin = settings?.gstin || "33AAFCI8876F1Z8";
    const supportPhone = settings?.support_phone || "+91 91801 02030";
    const supportEmail = settings?.support_email || "billing@infovex.com";
    const invoicePrefix = settings?.invoice_prefix || "INF-HOD-";

    const hallName = payment.marriage_halls?.hall_name || "Venue Host";
    const ownerName = payment.marriage_halls?.owner_name || "Hall Owner";
    const clientAddress = profile?.address || "";
    const clientCity = profile?.city || "";
    const clientState = profile?.state || "";
    const clientGstin = profile?.gst_number || "N/A";

    const invoiceNo = `${invoicePrefix}${payment.transaction_ref_no || payment.id.slice(-6).toUpperCase()}`;
    const invoiceDate = new Date(payment.created_at).toLocaleDateString("en-GB");
    const verifiedDate = payment.verified_at ? new Date(payment.verified_at).toLocaleDateString("en-GB") : "N/A";

    const baseAmount = parseFloat(payment.amount || 0);
    const taxEnabled = !!payment.tax_enabled;
    const taxRate = 0.18; // India standard SaaS GST 18%
    
    const subtotal = taxEnabled ? (baseAmount / (1 + taxRate)) : baseAmount;
    const totalTax = taxEnabled ? (baseAmount - subtotal) : 0;
    const cgst = totalTax / 2;
    const sgst = totalTax / 2;

    const symbol = "₹";
    const fmt = (val) => `${symbol}${Number(val).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let statusBadge = "";
    if (payment.status === "approved") {
      statusBadge = `<span style="background: #e6f4ea; color: #137333; border: 1px solid #c2e7c9; padding: 4px 10px; border-radius: 12px; font-weight: bold; font-size: 11px; text-transform: uppercase;">PAID</span>`;
    } else if (payment.status === "pending") {
      statusBadge = `<span style="background: #fef7e0; color: #b06000; border: 1px solid #fde293; padding: 4px 10px; border-radius: 12px; font-weight: bold; font-size: 11px; text-transform: uppercase;">PENDING VERIFICATION</span>`;
    } else {
      statusBadge = `<span style="background: #fce8e6; color: #c5221f; border: 1px solid #fad2cf; padding: 4px 10px; border-radius: 12px; font-weight: bold; font-size: 11px; text-transform: uppercase;">REJECTED</span>`;
    }

    let taxRows = "";
    if (taxEnabled) {
      taxRows = `
        <tr>
          <td>CGST (9%):</td>
          <td style="text-align: right; font-family: monospace;">${fmt(cgst)}</td>
        </tr>
        <tr>
          <td>SGST (9%):</td>
          <td style="text-align: right; font-family: monospace;">${fmt(sgst)}</td>
        </tr>
      `;
    }

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SaaS Subscription Invoice - ${invoiceNo}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    
    @page {
      size: auto;
      margin: 15mm;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      color: #1e293b;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .invoice-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 10px;
    }

    .header-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 30px;
    }

    .header-table td {
      vertical-align: top;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 800;
      color: #4f46e5;
      letter-spacing: -0.5px;
      margin: 0;
      line-height: 1;
    }

    .logo-sub {
      font-size: 9px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 2px;
    }

    .invoice-title-block {
      text-align: right;
    }

    .invoice-title {
      font-size: 26px;
      font-weight: 800;
      color: #4f46e5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0;
    }

    .meta-details {
      margin-top: 8px;
      font-size: 11px;
      color: #475569;
      font-weight: 500;
    }

    .meta-details strong {
      color: #0f172a;
    }

    .address-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 35px;
    }

    .address-table td {
      width: 50%;
      vertical-align: top;
    }

    .address-block {
      padding-right: 20px;
    }

    .address-title {
      font-size: 10px;
      font-weight: 800;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .address-name {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 4px 0;
    }

    .address-text {
      font-size: 12px;
      color: #475569;
      margin: 0;
      font-weight: 500;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 30px;
    }

    .items-table th {
      background-color: #f8fafc;
      color: #475569;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 12px 16px;
      text-align: left;
      border-bottom: 2px solid #e2e8f0;
    }

    .items-table td {
      padding: 16px;
      font-size: 12px;
      border-bottom: 1px solid #f1f5f9;
    }

    .item-desc {
      font-weight: 700;
      color: #0f172a;
    }

    .item-sub {
      font-size: 10px;
      color: #64748b;
      margin-top: 4px;
      font-weight: 500;
    }

    .totals-table {
      width: 40%;
      margin-left: auto;
      border-collapse: collapse;
      margin-bottom: 40px;
    }

    .totals-table td {
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 500;
      color: #475569;
    }

    .totals-table tr.grand-total {
      border-top: 2px solid #e2e8f0;
      font-size: 14px;
      font-weight: 800;
      color: #0f172a;
    }

    .totals-table tr.grand-total td {
      padding-top: 12px;
      font-weight: 800;
      color: #0f172a;
    }

    .footer-note {
      font-size: 10px;
      color: #94a3b8;
      text-align: center;
      margin-top: 50px;
      font-weight: 600;
      border-top: 1px solid #f1f5f9;
      padding-top: 15px;
    }

    .payment-info-box {
      background-color: #f8fafc;
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      padding: 15px;
      font-size: 11px;
      color: #475569;
      margin-bottom: 20px;
    }

    .payment-info-title {
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    @media print {
      body {
        margin: 0;
      }
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <table class="header-table">
      <tr>
        <td>
          <div style="display: flex; align-items: center; gap: 10px;">
            <img src="/logo.png" alt="Logo" style="height: 38px; object-fit: contain;">
            <div>
              <div class="logo-text">Infovex Halls</div>
              <div class="logo-sub">Venue CRM & ERP</div>
            </div>
          </div>
        </td>
        <td class="invoice-title-block">
          <div class="invoice-title">Invoice</div>
          <div class="meta-details">
            <div>Invoice No: <strong>${invoiceNo}</strong></div>
            <div>Date: <strong>${invoiceDate}</strong></div>
            <div style="margin-top: 6px;">Status: ${statusBadge}</div>
          </div>
        </td>
      </tr>
    </table>

    <table class="address-table">
      <tr>
        <td>
          <div class="address-block">
            <div class="address-title">Billed By</div>
            <div class="address-name">${companyName}</div>
            <div class="address-text">
              12, Ground Floor, Infovex Tech Hub<br>
              GSTIN: ${companyGstin}<br>
              Email: ${supportEmail} | Phone: ${supportPhone}
            </div>
          </div>
        </td>
        <td>
          <div class="address-block">
            <div class="address-title">Billed To</div>
            <div class="address-name">${hallName}</div>
            <div class="address-text">
              Proprietor: ${ownerName}<br>
              ${clientAddress ? `${clientAddress}, ` : ""}${clientCity ? `${clientCity}, ` : ""}${clientState}<br>
              GSTIN: ${clientGstin}
            </div>
          </div>
        </td>
      </tr>
    </table>

    <table class="items-table">
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align: right; width: 100px;">Qty</th>
          <th style="text-align: right; width: 150px;">Rate</th>
          <th style="text-align: right; width: 150px;">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div class="item-desc">Infovex Halls SaaS Subscription</div>
            <div class="item-sub">Package: ${payment.packages?.name || "SaaS Plan"} (${payment.packages?.billing_cycle || "monthly"})</div>
          </td>
          <td style="text-align: right;">1</td>
          <td style="text-align: right; font-family: monospace;">${fmt(subtotal)}</td>
          <td style="text-align: right; font-weight: 600; font-family: monospace;">${fmt(subtotal)}</td>
        </tr>
      </tbody>
    </table>

    <table style="width: 100%; border-collapse: collapse;">
      <tr>
        <td style="width: 55%; vertical-align: top;">
          <div class="payment-info-box">
            <div class="payment-info-title">Transaction & Remittance Details</div>
            <div>Payment Method: <strong style="text-transform: uppercase;">${payment.payment_method}</strong></div>
            <div>Bank Reference / UTR: <strong style="font-family: monospace;">${payment.transaction_ref_no}</strong></div>
            <div>Submitted On: <strong>${new Date(payment.created_at).toLocaleDateString("en-GB")}</strong></div>
            ${payment.verified_at ? `<div>Verified On: <strong>${verifiedDate}</strong></div>` : ""}
            ${payment.notes ? `<div style="margin-top: 6px; font-style: italic;">Notes: ${payment.notes}</div>` : ""}
          </div>
        </td>
        <td style="width: 45%; vertical-align: top;">
          <table class="totals-table">
            <tr>
              <td>Subtotal:</td>
              <td style="text-align: right; font-family: monospace;">${fmt(subtotal)}</td>
            </tr>
            ${taxRows}
            <tr class="grand-total">
              <td>Total Paid:</td>
              <td style="text-align: right; font-family: monospace;">${fmt(baseAmount)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <div class="footer-note">
      Powered by Infovex Halls — India's First dedicated Venue CRM by Infovex Technologies
    </div>
  </div>
</body>
</html>
`;
    res.setHeader("Content-Type", "text/html");
    res.send(htmlContent);
  } catch (err) {
    console.error("getSubscriptionInvoiceHtml error:", err);
    res.status(500).send("<h3>Internal Server Error</h3>");
  }
};

module.exports = {
  getSubscription,
  renewSubscription,
  changePackage,
  requestSubscriptionChange,
  submitSubscriptionPayment,
  getSubscriptionPaymentHistory,
  getSubscriptionInvoiceHtml
};