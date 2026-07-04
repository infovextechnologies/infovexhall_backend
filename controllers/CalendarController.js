const { supabaseAdmin } = require("../config/supabase");

/* ============================================================
   GET CALENDAR EVENTS
   Supports: monthly view, date range, full list
   ============================================================ */
const getEvents = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { year, month, from_date, to_date, start, end } = req.query;
    const finalFromDate = from_date || start;
    const finalToDate = to_date || end;

    let query = supabaseAdmin
      .from("events")
      .select(`
        *,
        bookings (
          id, event_name, event_type, status, total_amount, advance_amount,
          customers ( id, customer_name, phone )
        )
      `)
      .eq("hall_id", hall_id)
      .order("event_date", { ascending: true });

    // Monthly view
    if (year && month) {
      const paddedMonth = String(month).padStart(2, "0");
      const daysInMonth = new Date(year, month, 0).getDate();
      query = query
        .gte("event_date", `${year}-${paddedMonth}-01`)
        .lte("event_date", `${year}-${paddedMonth}-${daysInMonth}`);
    } else if (finalFromDate && finalToDate) {
      query = query.gte("event_date", finalFromDate).lte("event_date", finalToDate);
    } else if (finalFromDate) {
      query = query.gte("event_date", finalFromDate);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    res.json(data);
  } catch (err) {
    console.error("getEvents error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CREATE STANDALONE EVENT (not linked to booking)
   ============================================================ */
const createEvent = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const {
      event_title,
      event_date,
      end_date,
      all_day,
      type,
      hall_section,
      notes,
      status,
      guest_count,
      start_time,
      end_time,
      booking_id,
    } = req.body;

    if (!event_title || !event_date) {
      return res.status(400).json({ message: "event_title and event_date are required" });
    }

    // If booking_id provided, validate it belongs to hall
    if (booking_id) {
      const { data: booking } = await supabaseAdmin
        .from("bookings")
        .select("id")
        .eq("id", booking_id)
        .eq("hall_id", hall_id)
        .maybeSingle();

      if (!booking) return res.status(404).json({ message: "Booking not found in your hall" });
    }

    const { data, error } = await supabaseAdmin
      .from("events")
      .insert([{
        hall_id,
        event_title,
        event_date,
        end_date: end_date || event_date,
        all_day: all_day ?? false,
        type: type || "personal",
        hall_section: hall_section || "Main Hall",
        notes: notes || "",
        status: status || "confirmed",
        guest_count: guest_count || null,
        start_time,
        end_time,
        booking_id,
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: "Event created successfully", data });
  } catch (err) {
    console.error("createEvent error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE EVENT
   ============================================================ */
const updateEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const {
      event_title,
      event_date,
      end_date,
      all_day,
      type,
      hall_section,
      notes,
      status,
      guest_count,
      start_time,
      end_time,
    } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("events")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Event not found in your hall" });

    const updates = {};
    if (event_title !== undefined) updates.event_title = event_title;
    if (event_date !== undefined) updates.event_date = event_date;
    if (end_date !== undefined) updates.end_date = end_date;
    if (all_day !== undefined) updates.all_day = all_day;
    if (type !== undefined) updates.type = type;
    if (hall_section !== undefined) updates.hall_section = hall_section;
    if (notes !== undefined) updates.notes = notes;
    if (status !== undefined) updates.status = status;
    if (guest_count !== undefined) updates.guest_count = guest_count;
    if (start_time !== undefined) updates.start_time = start_time;
    if (end_time !== undefined) updates.end_time = end_time;

    const { error } = await supabaseAdmin.from("events").update(updates).eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Event updated successfully" });
  } catch (err) {
    console.error("updateEvent error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DELETE EVENT
   ============================================================ */
const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: existing } = await supabaseAdmin
      .from("events")
      .select("id, booking_id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Event not found in your hall" });

    if (existing.booking_id) {
      return res.status(400).json({
        message: "This event is linked to a booking. Cancel the booking instead.",
      });
    }

    const { error } = await supabaseAdmin.from("events").delete().eq("id", id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("deleteEvent error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET UPCOMING EVENTS
   ============================================================ */
const getUpcomingEvents = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { days = 30 } = req.query;

    const today = new Date().toISOString().split("T")[0];
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));
    const futureDateStr = futureDate.toISOString().split("T")[0];

    const { data, error } = await supabaseAdmin
      .from("events")
      .select(`
        *,
        bookings (
          id, event_name, status,
          customers ( customer_name, phone )
        )
      `)
      .eq("hall_id", hall_id)
      .gte("event_date", today)
      .lte("event_date", futureDateStr)
      .order("event_date", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    res.json({ data, days_ahead: parseInt(days) });
  } catch (err) {
    console.error("getUpcomingEvents error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getEvents, createEvent, updateEvent, deleteEvent, getUpcomingEvents };