const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");
const { getLocalDate } = require("../utils/dateHelper");
const { syncInvoiceAndEvictCache } = require("./invoiceController");

/* ============================================================
   ADD PAYMENT
   ============================================================ */
const createPayment = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { booking_id, amount, payment_method, payment_date, notes, reference_number, referenceNumber } = req.body;
    const actualRef = reference_number || referenceNumber;

    let finalNotes = notes || "";
    if (actualRef) {
      finalNotes = finalNotes ? `${finalNotes} (Ref: ${actualRef})` : `Ref: ${actualRef}`;
    }

    if (!booking_id || !amount) {
      return res.status(400).json({ message: "booking_id and amount are required" });
    }

    if (amount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    // Validate booking belongs to this hall and isn't cancelled
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("id, total_amount, status, payments(amount)")
      .eq("id", booking_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ message: "Booking not found in your hall" });
    if (booking.status === "cancelled") return res.status(400).json({ message: "Cannot add payment to a cancelled booking" });

    // Check for overpayment
    const alreadyPaid = (booking.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const remaining = (booking.total_amount || 0) - alreadyPaid;

    if (amount > remaining) {
      return res.status(400).json({
        message: `Payment amount (${amount}) exceeds remaining balance (${remaining})`,
        remaining_balance: remaining,
        total_paid: alreadyPaid,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("payments")
      .insert([{
        hall_id,
        booking_id,
        amount,
        payment_method: payment_method || "cash",
        payment_date: payment_date || getLocalDate(),
        notes: finalNotes,
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Check if booking is now fully paid and update status
    const newTotal = alreadyPaid + amount;
    if (newTotal >= (booking.total_amount || 0)) {
      await supabaseAdmin
        .from("bookings")
        .update({ status: "completed" })
        .eq("id", booking_id);
    }

    // Sync invoice totals and status, and evict the cached PDF from storage
    await syncInvoiceAndEvictCache(booking_id, hall_id);

    res.status(201).json({
      message: "Payment recorded successfully",
      data,
      remaining_balance: remaining - amount,
    });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "payment.added",
      entity_type: "payment",
      entity_id: data.id,
      description: `Recorded payment of ₹${amount} via ${payment_method || "cash"} for booking #${booking_id.slice(0, 8).toUpperCase()}`,
      metadata: { booking_id, amount, payment_method },
    });
  } catch (err) {
    console.error("createPayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL PAYMENTS FOR HALL
   ============================================================ */
const getPayments = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { from_date, to_date, payment_method, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("payments")
      .select(`
        *,
        bookings (
          id, event_name, start_date, status,
          customers ( id, customer_name, phone )
        )
      `, { count: "exact" })
      .eq("hall_id", hall_id)
      .order("payment_date", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (from_date) query = query.gte("payment_date", from_date);
    if (to_date) query = query.lte("payment_date", to_date);
    if (payment_method) query = query.eq("payment_method", payment_method);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const totalAmount = data.reduce((s, p) => s + (p.amount || 0), 0);

    res.json({
      data,
      summary: { total_amount: totalAmount, total_transactions: count },
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getPayments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET PAYMENTS BY BOOKING
   ============================================================ */
const getPaymentsByBooking = async (req, res) => {
  try {
    const { booking_id } = req.params;
    const hall_id = req.user.hall_id;

    // Ensure booking belongs to hall
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("id, event_name, total_amount, status, customers(customer_name, phone)")
      .eq("id", booking_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ message: "Booking not found in your hall" });

    const { data: payments, error } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("booking_id", booking_id)
      .order("payment_date", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });

    const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0);

    res.json({
      booking,
      payments,
      summary: {
        total_amount: booking.total_amount || 0,
        total_paid: totalPaid,
        pending_amount: (booking.total_amount || 0) - totalPaid,
      },
    });
  } catch (err) {
    console.error("getPaymentsByBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE PAYMENT
   ============================================================ */
const deletePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing } = await supabaseAdmin
      .from("payments")
      .select("id, booking_id, amount")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Payment not found in your hall" });

    const { error } = await supabaseAdmin.from("payments").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    // Revert booking status if it was marked completed
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("total_amount, status, payments(amount)")
      .eq("id", existing.booking_id)
      .single();

    if (booking?.status === "completed") {
      const newPaid = (booking.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
      if (newPaid < (booking.total_amount || 0)) {
        await supabaseAdmin
          .from("bookings")
          .update({ status: "confirmed" })
          .eq("id", existing.booking_id);
      }
    }

    // Sync invoice totals and status, and evict the cached PDF from storage
    await syncInvoiceAndEvictCache(existing.booking_id, hall_id);

    res.json({ message: "Payment deleted successfully" });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "payment.deleted",
      entity_type: "payment",
      entity_id: id,
      description: `Deleted payment of ₹${existing.amount} for booking #${existing.booking_id.slice(0, 8).toUpperCase()}`,
      metadata: { booking_id: existing.booking_id, amount: existing.amount },
    });
  } catch (err) {
    console.error("deletePayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   PAYMENT STATS / REVENUE SUMMARY
   ============================================================ */
const getPaymentStats = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { year, month } = req.query;

    let query = supabaseAdmin
      .from("payments")
      .select("amount, payment_method, payment_date")
      .eq("hall_id", hall_id);

    if (year) {
      query = query.gte("payment_date", `${year}-01-01`).lte("payment_date", `${year}-12-31`);
    }
    if (month && year) {
      const paddedMonth = String(month).padStart(2, "0");
      const daysInMonth = new Date(year, month, 0).getDate();
      query = query
        .gte("payment_date", `${year}-${paddedMonth}-01`)
        .lte("payment_date", `${year}-${paddedMonth}-${daysInMonth}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const totalRevenue = data.reduce((s, p) => s + (p.amount || 0), 0);

    // Group by payment method
    const byMethod = data.reduce((acc, p) => {
      acc[p.payment_method] = (acc[p.payment_method] || 0) + (p.amount || 0);
      return acc;
    }, {});

    // Monthly breakdown (if year provided)
    const byMonth = data.reduce((acc, p) => {
      const m = p.payment_date?.slice(0, 7);
      if (m) acc[m] = (acc[m] || 0) + (p.amount || 0);
      return acc;
    }, {});

    // Fetch all active bookings to calculate total contract value and paid value
    const { data: bookingsData } = await supabaseAdmin
      .from("bookings")
      .select("total_amount")
      .neq("status", "cancelled")
      .eq("hall_id", hall_id);

    // Fetch all payments to date for this hall to calculate cumulative payments
    const { data: allPayments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("hall_id", hall_id);

    const totalContractValue = (bookingsData || []).reduce((sum, b) => sum + Number(b.total_amount || 0), 0);
    const totalPaymentsReceived = (allPayments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const totalPending = Math.max(0, totalContractValue - totalPaymentsReceived);
    const collectionRate = totalContractValue > 0 ? (totalPaymentsReceived / totalContractValue) : 0;

    res.json({
      total_revenue: totalRevenue,
      total_transactions: data.length,
      by_payment_method: byMethod,
      by_month: byMonth,
      total_pending: totalPending,
      collection_rate: collectionRate,
    });
  } catch (err) {
    console.error("getPaymentStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE PAYMENT
   ============================================================ */
const updatePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { amount, paymentMethod, payment_method, paymentDate, payment_date, notes, referenceNumber, reference_number } = req.body;

    const actualMethod = payment_method || paymentMethod;
    const actualDate = payment_date || paymentDate;
    const actualRef = reference_number || referenceNumber;

    // Check if payment exists
    const { data: existingPayment, error: fetchErr } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (fetchErr || !existingPayment) {
      return res.status(404).json({ message: "Payment transaction not found" });
    }

    const booking_id = existingPayment.booking_id;

    // Load booking details to check balance
    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("id, total_amount, status, payments(id, amount)")
      .eq("id", booking_id)
      .single();

    if (!booking) return res.status(404).json({ message: "Associated booking not found" });

    // Calculate remaining balance by excluding THIS payment's previous amount
    const otherPaymentsSum = (booking.payments || [])
      .filter((p) => p.id !== id)
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const remaining = (booking.total_amount || 0) - otherPaymentsSum;

    if (amount !== undefined && amount > remaining) {
      return res.status(400).json({
        message: `Updated payment amount (${amount}) exceeds remaining balance (${remaining})`,
        remaining_balance: remaining,
      });
    }

    // Update payment in db
    const updates = {};
    if (amount !== undefined) updates.amount = amount;
    if (actualMethod !== undefined) updates.payment_method = actualMethod;
    if (actualDate !== undefined) updates.payment_date = actualDate;

    if (notes !== undefined || actualRef !== undefined) {
      let currentNotes = existingPayment.notes || "";
      currentNotes = currentNotes.replace(/\(Ref:\s*[A-Za-z0-9_-]+\)/i, "").replace(/Ref:\s*[A-Za-z0-9_-]+/i, "").trim();

      let baseNotes = notes !== undefined ? notes : currentNotes;
      let refToSave = actualRef !== undefined ? actualRef : "";

      if (actualRef === undefined) {
        const match = (existingPayment.notes || "").match(/(?:Ref|UTR):\s*([A-Za-z0-9_-]+)/i) || (existingPayment.notes || "").match(/\(Ref:\s*([A-Za-z0-9_-]+)\)/i);
        if (match) {
          refToSave = match[1];
        }
      }

      let finalNotes = baseNotes;
      if (refToSave) {
        finalNotes = finalNotes ? `${finalNotes} (Ref: ${refToSave})` : `Ref: ${refToSave}`;
      }
      updates.notes = finalNotes;
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("payments")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ message: updateErr.message });

    // Update booking status if fully paid
    const newTotal = otherPaymentsSum + (amount !== undefined ? amount : existingPayment.amount);
    const expectedStatus = newTotal >= (booking.total_amount || 0) ? "completed" : "confirmed";
    if (booking.status !== expectedStatus && booking.status !== "cancelled") {
      await supabaseAdmin
        .from("bookings")
        .update({ status: expectedStatus })
        .eq("id", booking_id);
    }

    // Sync invoice totals and status, and evict the cached PDF from storage
    await syncInvoiceAndEvictCache(booking_id, hall_id);

    res.json({
      message: "Payment updated successfully",
      data: updated,
    });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "payment.updated",
      entity_type: "payment",
      entity_id: id,
      description: `Updated payment of booking #${booking_id.slice(0, 8).toUpperCase()} to ₹${amount !== undefined ? amount : existingPayment.amount}`,
      metadata: { booking_id, amount, payment_method: actualMethod },
    });

  } catch (err) {
    console.error("updatePayment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createPayment,
  getPayments,
  getPaymentsByBooking,
  deletePayment,
  getPaymentStats,
  updatePayment,
};