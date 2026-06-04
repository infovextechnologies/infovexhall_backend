const { supabaseAdmin } = require("../config/supabase");

/*
  Enquiry pipeline:
  new → contacted → visit_scheduled → negotiation → booked → lost

  "booked" means this enquiry was converted to a real booking.
  "lost" means the customer chose another hall or dropped off.
*/

const VALID_STATUSES = ["new", "contacted", "visit_scheduled", "negotiation", "booked", "lost"];

const VALID_TRANSITIONS = {
  new:             ["contacted", "lost"],
  contacted:       ["visit_scheduled", "negotiation", "lost"],
  visit_scheduled: ["negotiation", "booked", "lost"],
  negotiation:     ["booked", "lost"],
  booked:          [],
  lost:            [],
};

/* ============================================================
   CREATE ENQUIRY
   ============================================================ */
const createEnquiry = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const {
      customer_name,
      phone,
      email,
      event_type,
      expected_date,
      expected_end_date,
      guest_count,
      budget,
      notes,
      source,          // "walk_in" | "phone" | "whatsapp" | "referral" | "online" | "other"
    } = req.body;

    if (!customer_name || !phone) {
      return res.status(400).json({ message: "customer_name and phone are required" });
    }

    // Prevent duplicate enquiry from same phone within 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: duplicate } = await supabaseAdmin
      .from("enquiries")
      .select("id, status, created_at")
      .eq("hall_id", hall_id)
      .eq("phone", phone)
      .not("status", "in", '("booked","lost")')
      .gte("created_at", thirtyDaysAgo.toISOString())
      .maybeSingle();

    if (duplicate) {
      return res.status(409).json({
        message: "An active enquiry already exists for this phone number",
        existing_enquiry_id: duplicate.id,
        status: duplicate.status,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("enquiries")
      .insert([{
        hall_id,
        customer_name,
        phone,
        email,
        event_type,
        expected_date,
        expected_end_date,
        guest_count,
        budget,
        notes,
        source: source || "phone",
        status: "new",
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Auto-create first followup reminder (next day)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    await supabaseAdmin.from("enquiry_followups").insert([{
      enquiry_id: data.id,
      hall_id,
      followup_date: tomorrow.toISOString().split("T")[0],
      method: "phone",
      notes: "Initial followup call",
      created_by: req.user.id,
      created_by_name: req.user.name,
      status: "pending",
    }]);

    res.status(201).json({ message: "Enquiry created successfully", data });
  } catch (err) {
    console.error("createEnquiry error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ALL ENQUIRIES
   With filters: status, from_date, to_date, search, source
   ============================================================ */
const getEnquiries = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { status, from_date, to_date, search, source, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from("enquiries")
      .select(
        `*, enquiry_followups ( id, followup_date, method, status, notes, created_at )`,
        { count: "exact" }
      )
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq("status", status);
    if (source) query = query.eq("source", source);
    if (from_date) query = query.gte("expected_date", from_date);
    if (to_date) query = query.lte("expected_date", to_date);
    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ message: error.message });

    // Add followup summary to each enquiry
    const enriched = data.map((enq) => {
      const followups = enq.enquiry_followups || [];
      const pending = followups.filter((f) => f.status === "pending");
      const overdue = pending.filter((f) => new Date(f.followup_date) < new Date());
      const nextFollowup = pending
        .filter((f) => new Date(f.followup_date) >= new Date())
        .sort((a, b) => new Date(a.followup_date) - new Date(b.followup_date))[0] || null;

      return {
        ...enq,
        followup_summary: {
          total: followups.length,
          pending: pending.length,
          overdue: overdue.length,
          next_followup: nextFollowup,
        },
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
    console.error("getEnquiries error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET ENQUIRY BY ID
   ============================================================ */
const getEnquiryById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("enquiries")
      .select(`
        *,
        enquiry_followups (
          id, followup_date, method, status, notes,
          created_by_name, created_at, completed_at
        )
      `)
      .eq("id", id)
      .eq("hall_id", hall_id)
      .single();

    if (error) return res.status(404).json({ message: "Enquiry not found" });

    // If enquiry was converted to a booking, include booking details
    let booking = null;
    if (data.booking_id) {
      const { data: bk } = await supabaseAdmin
        .from("bookings")
        .select("id, event_name, start_date, end_date, status, total_amount")
        .eq("id", data.booking_id)
        .maybeSingle();
      booking = bk;
    }

    res.json({ ...data, booking });
  } catch (err) {
    console.error("getEnquiryById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE ENQUIRY STATUS
   Validates pipeline transitions
   ============================================================ */
const updateEnquiryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { status, notes } = req.body;

    if (!status) return res.status(400).json({ message: "status is required" });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const { data: existing } = await supabaseAdmin
      .from("enquiries")
      .select("id, status")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Enquiry not found" });

    if (existing.status === status) {
      return res.status(400).json({ message: `Enquiry is already in "${status}" status` });
    }

    if (!VALID_TRANSITIONS[existing.status]?.includes(status)) {
      return res.status(400).json({
        message: `Cannot move from "${existing.status}" to "${status}". Allowed next: ${VALID_TRANSITIONS[existing.status]?.join(", ") || "none"}`,
      });
    }

    const updates = { status };
    if (notes) updates.notes = notes;
    if (status === "booked" || status === "lost") {
      updates.closed_at = new Date().toISOString();
    }

    const { error } = await supabaseAdmin
      .from("enquiries")
      .update(updates)
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: `Enquiry moved to "${status}"` });
  } catch (err) {
    console.error("updateEnquiryStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE ENQUIRY DETAILS
   ============================================================ */
const updateEnquiry = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const {
      customer_name,
      phone,
      email,
      event_type,
      expected_date,
      expected_end_date,
      guest_count,
      budget,
      notes,
      source,
    } = req.body;

    const { data: existing } = await supabaseAdmin
      .from("enquiries")
      .select("id, status")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Enquiry not found" });

    if (existing.status === "booked" || existing.status === "lost") {
      return res.status(400).json({ message: `Cannot edit a ${existing.status} enquiry` });
    }

    const updates = {};
    if (customer_name !== undefined) updates.customer_name = customer_name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (event_type !== undefined) updates.event_type = event_type;
    if (expected_date !== undefined) updates.expected_date = expected_date;
    if (expected_end_date !== undefined) updates.expected_end_date = expected_end_date;
    if (guest_count !== undefined) updates.guest_count = guest_count;
    if (budget !== undefined) updates.budget = budget;
    if (notes !== undefined) updates.notes = notes;
    if (source !== undefined) updates.source = source;

    const { error } = await supabaseAdmin
      .from("enquiries")
      .update(updates)
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Enquiry updated successfully" });
  } catch (err) {
    console.error("updateEnquiry error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   CONVERT ENQUIRY TO BOOKING
   Creates a customer + booking from the enquiry data
   ============================================================ */
const convertToBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { total_amount, advance_amount, event_name, start_date, end_date } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({ message: "start_date and end_date are required" });
    }

    const { data: enquiry } = await supabaseAdmin
      .from("enquiries")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    if (enquiry.status === "booked") {
      return res.status(400).json({ message: "Enquiry has already been converted to a booking" });
    }
    if (enquiry.status === "lost") {
      return res.status(400).json({ message: "Cannot convert a lost enquiry" });
    }

    // Check date availability
    const { data: conflicts } = await supabaseAdmin
      .from("bookings")
      .select("id, event_name, start_date, end_date")
      .eq("hall_id", hall_id)
      .not("status", "in", '("cancelled","enquiry")')
      .lte("start_date", end_date)
      .gte("end_date", start_date);

    if (conflicts && conflicts.length > 0) {
      return res.status(409).json({
        message: "Hall is not available for the selected dates",
        conflicts,
      });
    }

    // Find or create customer
    let customer_id;
    const { data: existingCustomer } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("hall_id", hall_id)
      .eq("phone", enquiry.phone)
      .maybeSingle();

    if (existingCustomer) {
      customer_id = existingCustomer.id;
    } else {
      const { data: newCustomer, error: custErr } = await supabaseAdmin
        .from("customers")
        .insert([{
          hall_id,
          customer_name: enquiry.customer_name,
          phone: enquiry.phone,
          email: enquiry.email,
          notes: `Converted from enquiry #${id}`,
        }])
        .select("id")
        .single();

      if (custErr) return res.status(500).json({ message: custErr.message });
      customer_id = newCustomer.id;
    }

    // Create booking
    const today = new Date().toISOString().split("T")[0];
    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from("bookings")
      .insert([{
        hall_id,
        customer_id,
        event_name: event_name || enquiry.event_type || "Event",
        event_type: enquiry.event_type,
        start_date,
        end_date,
        total_amount: total_amount || 0,
        advance_amount: advance_amount || 0,
        status: "confirmed",
        notes: enquiry.notes,
      }])
      .select()
      .single();

    if (bookingErr) return res.status(500).json({ message: bookingErr.message });

    // Record advance payment if provided
    if (advance_amount && advance_amount > 0) {
      await supabaseAdmin.from("payments").insert([{
        hall_id,
        booking_id: booking.id,
        amount: advance_amount,
        payment_method: "advance",
        payment_date: today,
        notes: `Advance payment — converted from enquiry`,
      }]);
    }

    // Create calendar event
    await supabaseAdmin.from("events").insert([{
      hall_id,
      booking_id: booking.id,
      event_title: event_name || enquiry.event_type || "Event",
      event_date: start_date,
      start_time: "09:00:00",
      end_time: "21:00:00",
    }]);

    // Mark enquiry as booked and link to booking
    await supabaseAdmin
      .from("enquiries")
      .update({ status: "booked", booking_id: booking.id, closed_at: new Date().toISOString() })
      .eq("id", id);

    res.status(201).json({
      message: "Enquiry converted to booking successfully",
      booking_id: booking.id,
      customer_id,
    });
  } catch (err) {
    console.error("convertToBooking error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   ENQUIRY STATS
   Pipeline summary for dashboard
   ============================================================ */
const getEnquiryStats = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const { data: enquiries } = await supabaseAdmin
      .from("enquiries")
      .select("id, status, created_at, source")
      .eq("hall_id", hall_id);

    const stats = {
      total: enquiries?.length || 0,
      new: 0,
      contacted: 0,
      visit_scheduled: 0,
      negotiation: 0,
      booked: 0,
      lost: 0,
    };

    enquiries?.forEach((e) => {
      if (stats[e.status] !== undefined) stats[e.status]++;
    });

    // Conversion rate
    const closed = stats.booked + stats.lost;
    const conversion_rate = closed > 0 ? Math.round((stats.booked / closed) * 100) : 0;

    // Source breakdown
    const by_source = enquiries?.reduce((acc, e) => {
      acc[e.source || "unknown"] = (acc[e.source || "unknown"] || 0) + 1;
      return acc;
    }, {});

    // This month
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    const this_month = enquiries?.filter(
      (e) => new Date(e.created_at) >= firstOfMonth
    ).length || 0;

    res.json({
      pipeline: stats,
      conversion_rate,
      by_source,
      this_month,
    });
  } catch (err) {
    console.error("getEnquiryStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   ADD FOLLOWUP
   ============================================================ */
const addFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { followup_date, method, notes } = req.body;

    if (!followup_date) return res.status(400).json({ message: "followup_date is required" });

    const allowedMethods = ["phone", "whatsapp", "email", "in_person", "other"];
    if (method && !allowedMethods.includes(method)) {
      return res.status(400).json({ message: `method must be one of: ${allowedMethods.join(", ")}` });
    }

    // Verify enquiry belongs to hall
    const { data: enquiry } = await supabaseAdmin
      .from("enquiries")
      .select("id, status")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    if (enquiry.status === "booked" || enquiry.status === "lost") {
      return res.status(400).json({ message: `Cannot add followup to a ${enquiry.status} enquiry` });
    }

    const { data, error } = await supabaseAdmin
      .from("enquiry_followups")
      .insert([{
        enquiry_id: id,
        hall_id,
        followup_date,
        method: method || "phone",
        notes,
        created_by: req.user.id,
        created_by_name: req.user.name,
        status: "pending",
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: "Followup scheduled", data });
  } catch (err) {
    console.error("addFollowup error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   COMPLETE FOLLOWUP
   Mark a followup as done and optionally add outcome notes
   ============================================================ */
const completeFollowup = async (req, res) => {
  try {
    const { id, followup_id } = req.params;
    const hall_id = req.user.hall_id;
    const { outcome_notes } = req.body;

    const { data: followup } = await supabaseAdmin
      .from("enquiry_followups")
      .select("id, status")
      .eq("id", followup_id)
      .eq("enquiry_id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!followup) return res.status(404).json({ message: "Followup not found" });
    if (followup.status === "completed") {
      return res.status(400).json({ message: "Followup is already completed" });
    }

    const { error } = await supabaseAdmin
      .from("enquiry_followups")
      .update({
        status: "completed",
        outcome_notes,
        completed_at: new Date().toISOString(),
      })
      .eq("id", followup_id);

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: "Followup marked as completed" });
  } catch (err) {
    console.error("completeFollowup error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET FOLLOWUPS FOR AN ENQUIRY
   ============================================================ */
const getFollowups = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: enquiry } = await supabaseAdmin
      .from("enquiries")
      .select("id")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const { data, error } = await supabaseAdmin
      .from("enquiry_followups")
      .select("*")
      .eq("enquiry_id", id)
      .order("followup_date", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    res.json(data);
  } catch (err) {
    console.error("getFollowups error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET TODAY'S PENDING FOLLOWUPS (dashboard widget)
   ============================================================ */
const getTodaysFollowups = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const today = new Date().toISOString().split("T")[0];

    const { data, error } = await supabaseAdmin
      .from("enquiry_followups")
      .select(`
        *,
        enquiries ( id, customer_name, phone, event_type, status, expected_date )
      `)
      .eq("hall_id", hall_id)
      .eq("status", "pending")
      .lte("followup_date", today)
      .order("followup_date", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    const overdue = data.filter((f) => f.followup_date < today);
    const due_today = data.filter((f) => f.followup_date === today);

    res.json({
      total_pending: data.length,
      due_today: due_today.length,
      overdue: overdue.length,
      followups: data,
    });
  } catch (err) {
    console.error("getTodaysFollowups error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createEnquiry,
  getEnquiries,
  getEnquiryById,
  updateEnquiryStatus,
  updateEnquiry,
  convertToBooking,
  getEnquiryStats,
  addFollowup,
  completeFollowup,
  getFollowups,
  getTodaysFollowups,
};