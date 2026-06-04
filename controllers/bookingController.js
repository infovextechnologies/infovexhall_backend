const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   AVAILABILITY CHECK (reusable helper)
   ============================================================ */
const checkDateAvailability = async (hall_id, start_date, end_date, excludeBookingId = null) => {
  let query = supabaseAdmin
    .from("bookings")
    .select("id, event_name, start_date, end_date, status")
    .eq("hall_id", hall_id)
    .neq("status", "cancelled")
    .or(`start_date.lte.${end_date},end_date.gte.${start_date}`)
    .filter("start_date", "lte", end_date)
    .filter("end_date", "gte", start_date);

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
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({ message: "start_date and end_date are required" });
    }

    if (new Date(start_date) > new Date(end_date)) {
      return res.status(400).json({ message: "start_date cannot be after end_date" });
    }

    const conflicts = await checkDateAvailability(hall_id, start_date, end_date);

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
    } = req.body;

    if (!customer_id || !start_date || !end_date) {
      return res.status(400).json({ message: "customer_id, start_date, and end_date are required" });
    }

    if (new Date(start_date) > new Date(end_date)) {
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

    // ---- Check subscription booking limit ----
    const today = new Date().toISOString().split("T")[0];
    const { data: sub } = await supabaseAdmin
      .from("hall_subscriptions")
      .select("package_id, packages(max_bookings, name)")
      .eq("hall_id", hall_id)
      .eq("status", "active")
      .gte("end_date", today)
      .maybeSingle();

    if (sub?.packages?.max_bookings !== null && sub?.packages?.max_bookings !== undefined) {
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

    // ---- CRITICAL: Check double booking ----
    const conflicts = await checkDateAvailability(hall_id, start_date, end_date);
    if (conflicts.length > 0) {
      return res.status(409).json({
        message: "Hall is already booked for the selected dates",
        conflicts,
      });
    }

    // ---- Create booking ----
    const { data, error } = await supabaseAdmin
      .from("bookings")
      .insert([{
        hall_id,
        customer_id,
        event_name,
        event_type,
        start_date,
        end_date,
        total_amount: total_amount || 0,
        advance_amount: advance_amount || 0,
        status: "confirmed",
        notes,
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
      event_date: start_date,
      start_time: "09:00:00",
      end_time: "21:00:00",
    }]);

    // ---- If advance paid, record payment ----
    if (advance_amount && advance_amount > 0) {
      await supabaseAdmin.from("payments").insert([{
        hall_id,
        booking_id: data.id,
        amount: advance_amount,
        payment_method: "advance",
        payment_date: today,
        notes: "Advance payment at booking",
      }]);
    }

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
    const { status, from_date, to_date, customer_id, page = 1, limit = 20 } = req.query;
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
    } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("bookings")
      .select("id, start_date, end_date, status")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Booking not found in your hall" });

    if (existing.status === "cancelled") {
      return res.status(400).json({ message: "Cannot update a cancelled booking" });
    }

    // Check date conflicts if dates are being changed
    const newStart = start_date || existing.start_date;
    const newEnd = end_date || existing.end_date;

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

    const updates = {};
    if (event_name !== undefined) updates.event_name = event_name;
    if (event_type !== undefined) updates.event_type = event_type;
    if (start_date !== undefined) updates.start_date = start_date;
    if (end_date !== undefined) updates.end_date = end_date;
    if (total_amount !== undefined) updates.total_amount = total_amount;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    const { error } = await supabaseAdmin.from("bookings").update(updates).eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    // Sync calendar event if dates changed
    if (start_date || event_name) {
      const calendarUpdate = {};
      if (start_date) calendarUpdate.event_date = newStart;
      if (event_name) calendarUpdate.event_title = event_name;
      await supabaseAdmin.from("events").update(calendarUpdate).eq("booking_id", id);
    }

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

module.exports = {
  checkAvailability,
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  cancelBooking,
  getBookingStats,
};