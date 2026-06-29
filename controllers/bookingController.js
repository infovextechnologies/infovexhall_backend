const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");
const { getLocalDate } = require("../utils/dateHelper");

/* ============================================================
   AVAILABILITY CHECK (reusable helper)
   ============================================================ */
const extractDate = (dateTimeStr) => {
  if (!dateTimeStr) return null;
  return dateTimeStr.split(/[T\s]/)[0];
};

const extractTime = (dateTimeStr, defaultTime) => {
  if (!dateTimeStr) return defaultTime;
  const parts = dateTimeStr.split(/[T\s]/);
  if (parts.length > 1) {
    let timePart = parts[1];
    timePart = timePart.split(/[Z+-]/)[0];
    if (timePart.length === 5) timePart = `${timePart}:00`;
    return timePart;
  }
  return defaultTime;
};

const normalizeBookingDates = (start, end) => {
  let normalizedStart = start;
  let normalizedEnd = end || start;
  
  if (normalizedStart && normalizedStart.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(normalizedStart)) {
    normalizedStart = `${normalizedStart} 00:00:00`;
  }
  if (normalizedEnd && normalizedEnd.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(normalizedEnd)) {
    normalizedEnd = `${normalizedEnd} 23:59:59`;
  }
  return { start: normalizedStart, end: normalizedEnd };
};

/* ============================================================
   AVAILABILITY CHECK (reusable helper)
   ============================================================ */
const checkDateAvailability = async (hall_id, start_date, end_date, excludeBookingId = null) => {
  let query = supabaseAdmin
    .from("bookings")
    .select("id, event_name, start_date, end_date, status")
    .eq("hall_id", hall_id)
    .neq("status", "cancelled")
    .lt("start_date", end_date)
    .gt("end_date", start_date);

  if (excludeBookingId) {
    query = query.neq("id", excludeBookingId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

/* ============================================================
   CHECK AVAILABILITY (public endpoint)
   ============================================================ */
const checkAvailability = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { start_date, end_date, exclude_booking_id } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({ message: "start_date and end_date are required" });
    }

    const { start: finalStartDate, end: finalEndDate } = normalizeBookingDates(start_date, end_date);

    if (new Date(finalStartDate) > new Date(finalEndDate)) {
      return res.status(400).json({ message: "start_date cannot be after end_date" });
    }

    const conflicts = await checkDateAvailability(hall_id, finalStartDate, finalEndDate, exclude_booking_id || null);

    res.json({
      available: conflicts.length === 0,
      conflicts: conflicts.length > 0 ? conflicts : [],
      message: conflicts.length === 0
        ? "Hall is available for the selected dates"
        : `Hall is already booked for ${conflicts.length} conflicting date(s)`,
    });
  } catch (err) {
    console.error("checkAvailability error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CREATE BOOKING
   ============================================================ */
const createBooking = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const {
      customer_id,
      event_name,
      event_type,
      start_date,
      end_date,
      total_amount,
      advance_amount,
      notes,
      hall_section,
      guest_count,
      discount_amount,
      coordinator_name,
      coordinator_phone,
    } = req.body;

    if (!customer_id || !start_date || !end_date) {
      return res.status(400).json({ message: "customer_id, start_date, and end_date are required" });
    }

    const { start: finalStartDate, end: finalEndDate } = normalizeBookingDates(start_date, end_date);

    if (new Date(finalStartDate) > new Date(finalEndDate)) {
      return res.status(400).json({ message: "start_date cannot be after end_date" });
    }

    // ---- Validate customer belongs to this hall ----
    const { data: customer } = await supabaseAdmin
      .from("customers")
      .select("id, customer_name")
      .eq("id", customer_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!customer) return res.status(404).json({ message: "Customer not found in your hall" });

    // ---- Resolve GST & Tax Settings ----
    const { getSettingsForHall } = require("./hallSettingsController");
    const settings = await getSettingsForHall(hall_id);

    const bodyTaxEnabled = req.body.tax_enabled !== undefined ? req.body.tax_enabled : req.body.taxEnabled;
    const bodyTaxPercentage = req.body.tax_percentage !== undefined ? req.body.tax_percentage : req.body.taxPercentage;
    const bodySubtotal = req.body.subtotal !== undefined ? req.body.subtotal : req.body.subTotal;

    const finalTaxEnabled = bodyTaxEnabled !== undefined ? !!bodyTaxEnabled : settings.tax_enabled;
    const finalTaxPercentage = bodyTaxPercentage !== undefined ? Number(bodyTaxPercentage) : settings.tax_percentage;
    const finalSubtotal = bodySubtotal !== undefined ? Number(bodySubtotal) : Number(total_amount || 0);
    const finalDiscount = Number(discount_amount || 0);

    const taxableAmount = finalSubtotal - finalDiscount;
    const finalTaxAmount = finalTaxEnabled
      ? Math.round((taxableAmount * finalTaxPercentage) / 100 * 100) / 100
      : 0;

    const finalTotalAmount = taxableAmount + finalTaxAmount;

    // ---- Check subscription booking limit ----
    const today = getLocalDate();
    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(max_bookings, name)")
      .eq("hall_id", hall_id)
      .eq("status", "active")
      .gte("end_date", today)
      .maybeSingle();

    if (sub?.packages?.max_bookings !== null && sub?.packages?.max_bookings !== undefined && sub?.packages?.max_bookings > 0) {
      const { count: bookingCount } = await supabaseAdmin
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("hall_id", hall_id)
        .neq("status", "cancelled");

      if (bookingCount >= sub.packages.max_bookings) {
        return res.status(403).json({
          message: `Booking limit reached. Your ${sub.packages.name} plan allows a maximum of ${sub.packages.max_bookings} bookings. Please upgrade your plan.`,
        });
      }
    }

    // ---- Check double booking ----
    const conflicts = await checkDateAvailability(hall_id, finalStartDate, finalEndDate);
    if (conflicts.length > 0) {
      return res.status(409).json({
        message: "Hall is already booked for the selected dates",
        conflicts,
      });
    }

    // Generate unique friendly booking number
    const year = new Date().getFullYear();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const booking_number = `BKG-${year}-${randomSuffix}`;

    // ---- Create booking ----
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .insert([{
        hall_id,
        customer_id,
        booking_number,
        event_name,
        event_type,
        start_date: finalStartDate,
        end_date: finalEndDate,
        subtotal: finalSubtotal,
        tax_enabled: finalTaxEnabled,
        tax_percentage: finalTaxPercentage,
        tax_amount: finalTaxAmount,
        total_amount: finalTotalAmount,
        advance_amount: advance_amount || 0,
        status: "confirmed",
        notes,
        hall_section,
        guest_count,
        discount_amount: finalDiscount,
        coordinator_name: coordinator_name || null,
        coordinator_phone: coordinator_phone || null,
      }])
      .select(`
        *,
        customers ( id, customer_name, phone, email )
      `)
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // ---- Auto-create event in calendar ----
    await supabaseAdmin.from("events").insert([{
      hall_id,
      booking_id: data.id,
      event_title: event_name || "Booking",
      event_date: extractDate(finalStartDate),
      end_date: extractDate(finalEndDate),
      start_time: extractTime(finalStartDate, "09:00:00"),
      end_time: extractTime(finalEndDate, "21:00:00"),
      all_day: start_date.length <= 10,
    }]);

    // ---- If advance paid, record payment ----
    if (advance_amount && advance_amount > 0) {
      await supabaseAdmin.from("payments").insert([{
        hall_id,
        booking_id: data.id,
        amount: advance_amount,
        payment_method: "upi", // default or map
        payment_date: today,
        notes: "Advance payment at booking",
      }]);
    }

    // ---- Log Activity ----
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "booking.created",
      entity_type: "booking",
      entity_id: data.id,
      description: `Created booking for ${customer.customer_name} - ${event_name || event_type || "Event"}`,
      metadata: { total_amount, start_date, end_date, hall_section, booking_number },
    });

    res.status(201).json({ message: "Booking created successfully", data });
  } catch (err) {
    console.error("createBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL BOOKINGS
   ============================================================ */
const getBookings = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { status, from_date, to_date, customer_id, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("bookings")
      .select(`
        *,
        customers ( id, customer_name, phone, email ),
        payments ( id, amount, payment_method, payment_date )
      `, { count: "exact" })
      .eq("hall_id", hall_id)
      .order("start_date", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq("status", status);
    if (from_date) query = query.gte("start_date", from_date);
    if (to_date) query = query.lte("start_date", to_date);
    if (customer_id) query = query.eq("customer_id", customer_id);

    if (search && search.trim() !== "") {
      const cleanSearch = search.trim();
      
      const { data: matchingCustomers } = await supabaseAdmin
        .from("customers")
        .select("id")
        .eq("hall_id", hall_id)
        .or(`customer_name.ilike.%${cleanSearch}%,phone.ilike.%${cleanSearch}%,email.ilike.%${cleanSearch}%`);

      const customerIds = (matchingCustomers || []).map(c => c.id);

      let orConditions = `event_name.ilike.%${cleanSearch}%,event_type.ilike.%${cleanSearch}%,notes.ilike.%${cleanSearch}%,booking_number.ilike.%${cleanSearch}%,coordinator_name.ilike.%${cleanSearch}%`;
      if (customerIds.length > 0) {
        orConditions += `,customer_id.in.(${customerIds.join(",")})`;
      }

      query = query.or(orConditions);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    // Calculate pending amount per booking
    const enriched = data.map((booking) => {
      const paid = (booking.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      return {
        ...booking,
        paid_amount: paid,
        pending_amount: (booking.total_amount || 0) - paid,
      };
    });

    res.json({
      data: enriched,
      meta: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("getBookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET BOOKING BY ID
   ============================================================ */
const getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("bookings")
      .select(`
        *,
        customers ( id, customer_name, phone, email, address ),
        payments ( id, amount, payment_method, payment_date, notes ),
        events ( id, event_title, event_date, start_time, end_time )
      `)
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Booking not found" });

    const paid = (data.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);

    res.json({
      ...data,
      paid_amount: paid,
      pending_amount: (data.total_amount || 0) - paid,
    });
  } catch (err) {
    console.error("getBookingById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE BOOKING
   ============================================================ */
const updateBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const {
      event_name,
      event_type,
      start_date,
      end_date,
      total_amount,
      status,
      notes,
      hall_section,
      guest_count,
      discount_amount,
      coordinator_name,
      coordinator_phone,
    } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("bookings")
      .select("id, start_date, end_date, status, subtotal, total_amount, discount_amount, tax_enabled, tax_percentage, tax_amount")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Booking not found in your hall" });

    if (existing.status === "cancelled") {
      return res.status(400).json({ message: "Cannot update a cancelled booking" });
    }

    // Check date conflicts if dates are being changed
    let finalStartDate = start_date;
    let finalEndDate = end_date;

    if (finalStartDate && finalStartDate.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(finalStartDate)) {
      finalStartDate = `${finalStartDate} 00:00:00`;
    }
    if (finalEndDate && finalEndDate.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(finalEndDate)) {
      finalEndDate = `${finalEndDate} 23:59:59`;
    }

    const newStart = finalStartDate || existing.start_date;
    const newEnd = finalEndDate || existing.end_date;

    if (start_date || end_date) {
      if (new Date(newStart) > new Date(newEnd)) {
        return res.status(400).json({ message: "start_date cannot be after end_date" });
      }

      const conflicts = await checkDateAvailability(hall_id, newStart, newEnd, id);
      if (conflicts.length > 0) {
        return res.status(409).json({
          message: "Hall is already booked for the updated dates",
          conflicts,
        });
      }
    }

    // Recalculate Billing and Tax snapshot
    const bodyTaxEnabled = req.body.tax_enabled !== undefined ? req.body.tax_enabled : req.body.taxEnabled;
    const bodyTaxPercentage = req.body.tax_percentage !== undefined ? req.body.tax_percentage : req.body.taxPercentage;
    const bodySubtotal = req.body.subtotal !== undefined ? req.body.subtotal : req.body.subTotal;

    const finalTaxEnabled = bodyTaxEnabled !== undefined
      ? !!bodyTaxEnabled
      : (existing.tax_enabled !== null && existing.tax_enabled !== undefined ? existing.tax_enabled : false);

    const finalTaxPercentage = bodyTaxPercentage !== undefined
      ? Number(bodyTaxPercentage)
      : (existing.tax_percentage !== null && existing.tax_percentage !== undefined ? Number(existing.tax_percentage) : 0);

    const finalSubtotal = bodySubtotal !== undefined
      ? Number(bodySubtotal)
      : (total_amount !== undefined
          ? Number(total_amount)
          : (existing.subtotal !== null && existing.subtotal !== undefined ? Number(existing.subtotal) : Number(existing.total_amount || 0))
        );

    const finalDiscount = discount_amount !== undefined
      ? Number(discount_amount)
      : Number(existing.discount_amount || 0);

    const taxableAmount = finalSubtotal - finalDiscount;
    const finalTaxAmount = finalTaxEnabled
      ? Math.round((taxableAmount * finalTaxPercentage) / 100 * 100) / 100
      : 0;

    const finalTotalAmount = taxableAmount + finalTaxAmount;

    const updates = {};
    if (event_name !== undefined) updates.event_name = event_name;
    if (event_type !== undefined) updates.event_type = event_type;
    if (start_date !== undefined) updates.start_date = finalStartDate;
    if (end_date !== undefined) updates.end_date = finalEndDate;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (hall_section !== undefined) updates.hall_section = hall_section;
    if (guest_count !== undefined) updates.guest_count = guest_count;
    if (coordinator_name !== undefined) updates.coordinator_name = coordinator_name;
    if (coordinator_phone !== undefined) updates.coordinator_phone = coordinator_phone;

    // Financial updates
    updates.subtotal = finalSubtotal;
    updates.tax_enabled = finalTaxEnabled;
    updates.tax_percentage = finalTaxPercentage;
    updates.tax_amount = finalTaxAmount;
    updates.discount_amount = finalDiscount;
    updates.total_amount = finalTotalAmount;

    const { error } = await supabaseAdmin.from("bookings").update(updates).eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    // Sync Invoice if one exists
    try {
      const { data: invoice } = await supabaseAdmin
        .from("invoices")
        .select("id")
        .eq("booking_id", id)
        .maybeSingle();

      if (invoice) {
        const { data: payments } = await supabaseAdmin
          .from("payments")
          .select("amount")
          .eq("booking_id", id);
        const amount_paid = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
        const balance_due = finalTotalAmount - amount_paid;

        await supabaseAdmin
          .from("invoices")
          .update({
            subtotal: finalSubtotal,
            discount_amount: finalDiscount,
            tax_enabled: finalTaxEnabled,
            tax_percentage: finalTaxPercentage,
            tax_amount: finalTaxAmount,
            total_amount: finalTotalAmount,
            amount_paid,
            balance_due,
            status: balance_due <= 0 ? "paid" : "unpaid",
            updated_at: new Date().toISOString()
          })
          .eq("booking_id", id);
      }
    } catch (syncErr) {
      console.error("Error syncing invoice on booking update:", syncErr);
    }

    // Sync calendar event if dates changed
    if (start_date || end_date || event_name) {
      const calendarUpdate = {};
      if (start_date) {
        calendarUpdate.event_date = extractDate(newStart);
        calendarUpdate.start_time = extractTime(newStart, "09:00:00");
      }
      if (end_date) {
        calendarUpdate.end_date = extractDate(newEnd);
        calendarUpdate.end_time = extractTime(newEnd, "21:00:00");
      }
      if (event_name) {
        calendarUpdate.event_title = event_name;
      }
      if (start_date) {
        calendarUpdate.all_day = start_date.length <= 10;
      }
      await supabaseAdmin.from("events").update(calendarUpdate).eq("booking_id", id);
    }

    // ---- Log Activity ----
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "booking.updated",
      entity_type: "booking",
      entity_id: id,
      description: `Updated booking #${id.slice(0, 8).toUpperCase()} details`,
      metadata: { updated_fields: Object.keys(updates) },
    });

    res.json({ message: "Booking updated successfully" });
  } catch (err) {
    console.error("updateBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CANCEL BOOKING
   ============================================================ */
const cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing } = await supabaseAdmin
      .from("bookings")
      .select("id, status")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Booking not found in your hall" });
    if (existing.status === "cancelled") return res.status(400).json({ message: "Booking is already cancelled" });

    const { error } = await supabaseAdmin
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    // ---- Log Activity ----
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "booking.cancelled",
      entity_type: "booking",
      entity_id: id,
      description: `Cancelled booking #${id.slice(0, 8).toUpperCase()}`,
    });

    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    console.error("cancelBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   BOOKING STATS
   ============================================================ */
const getBookingStats = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const { data: bookings } = await supabaseAdmin
      .from("bookings")
      .select("id, status, total_amount, advance_amount")
      .eq("hall_id", hall_id);

    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("hall_id", hall_id);

    const total = bookings?.length || 0;
    const confirmed = bookings?.filter((b) => b.status === "confirmed").length || 0;
    const pending = bookings?.filter((b) => b.status === "pending").length || 0;
    const cancelled = bookings?.filter((b) => b.status === "cancelled").length || 0;
    const totalRevenue = bookings?.reduce((s, b) => s + (b.total_amount || 0), 0) || 0;
    const totalPaid = payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0;

    res.json({
      total,
      confirmed,
      pending,
      cancelled,
      total_revenue: totalRevenue,
      total_paid: totalPaid,
      total_pending: totalRevenue - totalPaid,
    });
  } catch (err) {
    console.error("getBookingStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const deleteBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    // Verify booking exists
    const { data: existing, error: findError } = await supabaseAdmin
      .from("bookings")
      .select("id, event_name")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (findError) return res.status(500).json({ message: findError.message });
    if (!existing) return res.status(404).json({ message: "Booking not found in your hall" });

    // Delete associated vendor allocations
    const { error: err1 } = await supabaseAdmin.from("booking_vendors").delete().eq("booking_id", id);
    if (err1) return res.status(500).json({ message: `Failed to delete vendor allocations: ${err1.message}` });

    // Delete associated events
    const { error: err2 } = await supabaseAdmin.from("events").delete().eq("booking_id", id);
    if (err2) return res.status(500).json({ message: `Failed to delete events: ${err2.message}` });

    // Delete associated payments
    const { error: err3 } = await supabaseAdmin.from("payments").delete().eq("booking_id", id);
    if (err3) return res.status(500).json({ message: `Failed to delete payments: ${err3.message}` });

    // Delete associated invoices
    const { error: err4 } = await supabaseAdmin.from("invoices").delete().eq("booking_id", id);
    if (err4) return res.status(500).json({ message: `Failed to delete invoices: ${err4.message}` });

    // Delete booking
    const { error: deleteError } = await supabaseAdmin.from("bookings").delete().eq("id", id);
    if (deleteError) return res.status(500).json({ message: `Failed to delete booking: ${deleteError.message}` });

    // ---- Log Activity ----
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "booking.deleted",
      entity_type: "booking",
      entity_id: id,
      description: `Deleted booking for event: ${existing.event_name}`,
    });

    res.json({ message: "Booking deleted successfully" });
  } catch (err) {
    console.error("deleteBooking error:", err);
    res.status(500).json({ message: `Server error: ${err.message}` });
  }
};

module.exports = {
  checkAvailability,
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  cancelBooking,
  getBookingStats,
  deleteBooking,
};