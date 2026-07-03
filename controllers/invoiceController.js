const { supabaseAdmin } = require("../config/supabase");
const { getSettingsForHall } = require("./hallSettingsController");
const { getLocalDate } = require("../utils/dateHelper");

// Helper to format dates to DD/MM/YYYY inside CSV
const formatToDDMMYYYY = (dateStr) => {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (e) {
    return dateStr;
  }
};

/* ============================================================
   CREATE INVOICE
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
        customers ( id, customer_name, phone, email, address, state ),
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
      .select("hall_name, phone, email, address, city, state, logo_url, gstin")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name, phone, email, address, city")
      .eq("id", hall_id)
      .single();

    // Generate sequential invoice number
    const year = new Date().getFullYear();
    const { count } = await supabaseAdmin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("hall_id", hall_id)
      .ilike("invoice_number", `${settings.invoice_prefix || "INV"}-%`);

    const invoiceNumber = `${settings.invoice_prefix || "INV"}-${year}-${String((count || 0) + 1).padStart(4, "0")}`;

    // Use booking tax settings if available, else fall back to global settings
    const tax_enabled = booking.tax_enabled !== null && booking.tax_enabled !== undefined
      ? booking.tax_enabled
      : settings.tax_enabled;

    let tax_percentage = booking.tax_percentage !== null && booking.tax_percentage !== undefined
      ? Number(booking.tax_percentage)
      : settings.tax_percentage;

    if (tax_enabled && (!tax_percentage || isNaN(tax_percentage) || Number(tax_percentage) === 0)) {
      tax_percentage = 18.00;
    }

    // Determine states to verify IGST vs CGST/SGST
    const hallState = (hallProfile?.state || "").trim().toLowerCase();
    const customerState = (booking.customers?.state || "").trim().toLowerCase();

    let tax_label = booking.tax_label || settings.tax_label || "GST";
    if (tax_enabled) {
      if (hallState && customerState && hallState !== customerState) {
        tax_label = `IGST (${tax_percentage}%)`;
      } else {
        const half = tax_percentage / 2;
        tax_label = `CGST (${half}%) + SGST (${half}%)`;
      }
    }

    let subtotal = 0;
    if (line_items && Array.isArray(line_items) && line_items.length > 0) {
      subtotal = line_items.reduce((sum, item) => sum + (Number(item.quantity || 1) * Number(item.unit_price || 0)), 0);
    } else {
      subtotal = booking.subtotal !== null && booking.subtotal !== undefined
        ? Number(booking.subtotal)
        : Number(booking.bookingAmount || booking.total_amount || 0);
    }

    const discount = discount_amount !== undefined ? Number(discount_amount) : Number(booking.discount_amount || 0);
    const taxable_amount = subtotal - discount;

    const tax_amount = tax_enabled
      ? Math.round((taxable_amount * tax_percentage) / 100 * 100) / 100
      : 0;

    const total_amount = taxable_amount + tax_amount;

    const items = line_items || [
      {
        description: booking.event_name || `${booking.event_type || "Venue"} Booking`,
        quantity: 1,
        unit_price: subtotal,
        amount: subtotal,
      },
    ];

    // Amount paid so far
    const amount_paid = (booking.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance_due = total_amount - amount_paid;

    const finalNotes = notes || settings.invoice_footer_note;

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
      event_date: booking.eventDate || booking.start_date,
      event_end_date: booking.eventEndDate || booking.end_date,

      // Financials
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
      currency: settings.currency || "INR",
      currency_symbol: settings.currency_symbol || "₹",

      notes: finalNotes,
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
   GET INVOICES
   ============================================================ */
const getInvoices = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const offset = (pageNum - 1) * limitNum;

    // 1. Build Query for Invoices
    let query = supabaseAdmin
      .from("invoices")
      .select("*", { count: "exact" })
      .eq("hall_id", hall_id);

    if (status && status !== 'all') {
      query = query.eq("status", status);
    }
    if (from_date) {
      query = query.gte("event_date", from_date);
    }
    if (to_date) {
      query = query.lte("event_date", to_date);
    }

    const { data: invoices, count, error } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (error) return res.status(500).json({ message: error.message });

    // 2. Fetch all invoices for this hall to compute the total summary statistics (non-paginated)
    const { data: allInvoices, error: summaryError } = await supabaseAdmin
      .from("invoices")
      .select("total_amount, amount_paid, balance_due")
      .eq("hall_id", hall_id);

    if (summaryError) return res.status(500).json({ message: summaryError.message });

    const total_invoiced = (allInvoices || []).reduce((sum, inv) => sum + (parseFloat(inv.total_amount) || 0), 0);
    const total_paid = (allInvoices || []).reduce((sum, inv) => sum + (parseFloat(inv.amount_paid) || 0), 0);
    const total_outstanding = (allInvoices || []).reduce((sum, inv) => sum + (parseFloat(inv.balance_due) || 0), 0);
    const totalCount = count || 0;

    res.json({
      data: invoices || [],
      summary: {
        total_invoiced,
        total_paid,
        total_outstanding,
        count: allInvoices ? allInvoices.length : 0
      },
      meta: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        total_pages: Math.ceil(totalCount / limitNum) || 1
      }
    });
  } catch (err) {
    console.error("getInvoices error:", err);
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
    if (!data) return res.status(404).json({ message: "Invoice not found for booking" });
    res.json(data);
  } catch (err) {
    console.error("getInvoiceByBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE INVOICE STATUS
   ============================================================ */
const updateInvoiceStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    // Fetch payments to recalculate
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("booking_id", invoice.booking_id)
      .eq("hall_id", hall_id);

    const amount_paid = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
    const balance_due = Math.max(0, invoice.total_amount - amount_paid);
    const status = balance_due <= 0 ? "paid" : "unpaid";

    const { data: updated, error } = await supabaseAdmin
      .from("invoices")
      .update({ amount_paid, balance_due, status })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: "Invoice synced with bookings successfully", data: updated });
  } catch (err) {
    console.error("updateInvoiceStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET INVOICE DOCUMENT DTO
   ============================================================ */
const getInvoiceDto = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: invoice, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error || !invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("hall_name, phone, email, address, city, state, logo_url, gstin, bank_name, account_number, ifsc_code, upi_id")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const settings = await getSettingsForHall(hall_id);

    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("id, amount, payment_method, payment_date, notes")
      .eq("booking_id", invoice.booking_id)
      .eq("hall_id", hall_id)
      .order("payment_date", { ascending: true });

    const dto = {
      documentType: "invoice",
      documentNumber: invoice.invoice_number,
      issueDate: invoice.invoice_date,
      dueDate: invoice.due_date,
      status: invoice.status,
      customer: {
        name: invoice.customer_name || "",
        phone: invoice.customer_phone || "",
        email: invoice.customer_email || "",
        address: invoice.customer_address || "",
      },
      hall: {
        name: profile?.hall_name || invoice.hall_name || "",
        phone: profile?.phone || invoice.hall_phone || "",
        email: profile?.email || invoice.hall_email || "",
        address: profile?.address ? `${profile.address}, ${profile.city || ""}` : (invoice.hall_address || ""),
        logoUrl: profile?.logo_url || invoice.hall_logo_url || null,
        gstin: profile?.gstin || invoice.hall_gstin || null,
        bankName: profile?.bank_name || "",
        bankAccount: profile?.account_number || "",
        bankIfsc: profile?.ifsc_code || "",
        bankBranch: "",
        upiId: profile?.upi_id || "",
        notes: invoice.notes || settings.invoice_footer_note || "",
      },
      items: (invoice.line_items || []).map(item => ({
        description: item.description || "Hall Booking Service",
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unit_price || 0),
        total: Number(item.quantity || 1) * Number(item.unit_price || 0),
      })),
      financials: {
        subtotal: Number(invoice.subtotal || 0),
        discountAmount: Number(invoice.discount_amount || 0),
        taxEnabled: Boolean(invoice.tax_enabled),
        taxPercentage: Number(invoice.tax_percentage || 0),
        taxLabel: invoice.tax_label || "GST",
        taxAmount: Number(invoice.tax_amount || 0),
        totalAmount: Number(invoice.total_amount || 0),
        amountPaid: Number(invoice.amount_paid || 0),
        balanceDue: Number(invoice.balance_due || 0),
        currencySymbol: invoice.currency_symbol || settings.currency_symbol || "₹",
      },
      payments: (payments || []).map(p => {
        let transactionId = null;
        if (p.notes) {
          const match = p.notes.match(/(?:Ref|UTR):\s*([A-Za-z0-9_-]+)/i) || p.notes.match(/\(Ref:\s*([A-Za-z0-9_-]+)\)/i);
          if (match) transactionId = match[1];
        }
        return {
          id: p.id,
          amount: Number(p.amount || 0),
          paymentMethod: p.payment_method || "cash",
          paymentDate: p.payment_date,
          transactionId: transactionId,
        };
      }),
      invoiceTemplate: settings.invoice_template || "classic",
      receiptTemplate: settings.booking_settings?.receiptTemplate || settings.invoice_template || "classic",
    };

    res.json(dto);
  } catch (err) {
    console.error("getInvoiceDto error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET PAYMENT RECEIPT DTO
   ============================================================ */
const getReceiptDto = async (req, res) => {
  try {
    const { payment_id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: payment, error } = await supabaseAdmin
      .from("payments")
      .select(`
        *,
        bookings (
          id, event_name, event_type, start_date, end_date, total_amount, subtotal, discount_amount, tax_enabled, tax_percentage, tax_amount,
          customers ( customer_name, phone, email, address )
        )
      `)
      .eq("id", payment_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error || !payment) {
      return res.status(404).json({ message: "Payment receipt not found" });
    }

    const { data: profile } = await supabaseAdmin
      .from("hall_profiles")
      .select("hall_name, phone, email, address, city, state, logo_url, gstin, bank_name, account_number, ifsc_code, upi_id")
      .eq("hall_id", hall_id)
      .maybeSingle();

    const settings = await getSettingsForHall(hall_id);

    const year = new Date(payment.payment_date || new Date()).getFullYear();
    const receiptNumber = `${settings.receipt_prefix || "RCP"}-${year}-${payment.id.slice(0, 6).toUpperCase()}`;

    // Fetch all payments for this booking to calculate cumulative amounts
    const { data: bookingPayments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("booking_id", payment.booking_id)
      .eq("hall_id", hall_id);

    const totalPaid = (bookingPayments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const balanceDue = Math.max(0, Number(payment.bookings?.total_amount || 0) - totalPaid);

    const dto = {
      documentType: "receipt",
      documentNumber: receiptNumber,
      issueDate: payment.payment_date,
      status: "paid",
      customer: {
        name: payment.bookings?.customers?.customer_name || "",
        phone: payment.bookings?.customers?.phone || "",
        email: payment.bookings?.customers?.email || "",
        address: payment.bookings?.customers?.address || "",
      },
      hall: {
        name: profile?.hall_name || "",
        phone: profile?.phone || "",
        email: profile?.email || "",
        address: profile?.address ? `${profile.address}, ${profile.city || ""}` : "",
        logoUrl: profile?.logo_url || null,
        gstin: profile?.gstin || null,
        bankName: profile?.bank_name || "",
        bankAccount: profile?.account_number || "",
        bankIfsc: profile?.ifsc_code || "",
        bankBranch: "",
        upiId: profile?.upi_id || "",
        notes: settings.invoice_footer_note || "Thank you for your payment.",
      },
      items: [
        {
          description: `Payment Receipt for event ${payment.bookings?.event_name || payment.bookings?.event_type || "Booking"} (Date: ${payment.bookings?.start_date || ""})`,
          quantity: 1,
          unitPrice: Number(payment.amount || 0),
          total: Number(payment.amount || 0),
        }
      ],
      financials: {
        subtotal: Number(payment.amount || 0),
        discountAmount: 0,
        taxEnabled: false,
        taxPercentage: 0,
        taxLabel: "GST",
        taxAmount: 0,
        totalAmount: Number(payment.amount || 0),
        amountPaid: Number(payment.amount || 0),
        balanceDue: balanceDue,
        currencySymbol: settings.currency_symbol || "₹",
        bookingTotal: Number(payment.bookings?.total_amount || 0),
        bookingTotalPaid: totalPaid,
      },
      payments: [
        {
          id: payment.id,
          amount: Number(payment.amount || 0),
          paymentMethod: payment.payment_method || "cash",
          paymentDate: payment.payment_date,
          transactionId: (() => {
            if (payment.notes) {
              const match = payment.notes.match(/(?:Ref|UTR):\s*([A-Za-z0-9_-]+)/i) || payment.notes.match(/\(Ref:\s*([A-Za-z0-9_-]+)\)/i);
              if (match) return match[1];
            }
            return null;
          })(),
        }
      ],
      invoiceTemplate: settings.invoice_template || "classic",
      receiptTemplate: settings.booking_settings?.receiptTemplate || settings.invoice_template || "classic",
    };

    res.json(dto);
  } catch (err) {
    console.error("getReceiptDto error:", err);
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

    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("id, invoice_number")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found or does not belong to your hall" });
    }

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

/* ============================================================
   EXPORT GSTR-1 REPORT
   ============================================================ */
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

/* ============================================================
   CACHE EVICTION & SYNC HELPERS
   ============================================================ */
const evictCachedPdf = async (path) => {
  // Since PDF storage caching is disabled, this is a safe no-op.
  return;
};

const syncInvoiceAndEvictCache = async (booking_id, hall_id) => {
  try {
    // 1. Fetch the invoice
    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("id, total_amount")
      .eq("booking_id", booking_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!invoice) return;

    // 2. Fetch all payments for this booking
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("booking_id", booking_id);

    const amount_paid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance_due = Math.max(0, (invoice.total_amount || 0) - amount_paid);
    const status = balance_due <= 0 ? "paid" : amount_paid > 0 ? "partial" : "unpaid";

    // 3. Update the invoice status and totals in the database
    await supabaseAdmin
      .from("invoices")
      .update({ amount_paid, balance_due, status })
      .eq("id", invoice.id);

    // 4. Safe call to cache evicter
    await evictCachedPdf(`invoices/${invoice.id}.pdf`);
  } catch (err) {
    console.error("syncInvoiceAndEvictCache error:", err);
  }
};

module.exports = {
  createInvoice,
  getInvoiceById,
  getInvoiceByBooking,
  getInvoices,
  updateInvoiceStatus,
  getInvoiceDto,
  getReceiptDto,
  deleteInvoice,
  exportGstr1Report,
  syncInvoiceAndEvictCache,
  evictCachedPdf,
};