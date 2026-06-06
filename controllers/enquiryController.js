const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

/*
  Enquiry pipeline (Aligned with Frontend):
  new → interested → visit_scheduled → visited → booked → lost

  "booked" means this enquiry was converted to a real booking.
  "lost" means the customer chose another hall or dropped off.
*/

const VALID_STATUSES = ["new", "interested", "visit_scheduled", "visited", "booked", "lost"];

const VALID_TRANSITIONS = {
  new:             ["interested", "lost"],
  interested:      ["visit_scheduled", "lost"],
  visit_scheduled: ["visited", "booked", "lost"],
  visited:         ["booked", "lost"],
  booked:          [],
  lost:            [],
};

const generateEnquiryNumber = async (hall_id) => {
  const year = new Date().getFullYear();
  const { count } = await supabaseAdmin
    .from("enquiries")
    .select("id", { count: "exact", head: true })
    .eq("hall_id", hall_id)
    .ilike("enquiry_number", `ENQ-${year}-%`);

  const sequence = String((count || 0) + 1).padStart(4, "0");
  return `ENQ-${year}-${sequence}`;
};

const getEnquiryFields = (body) => {
  const fields = {};
  if (body.customer_name !== undefined) fields.customer_name = body.customer_name;
  else if (body.name !== undefined) fields.customer_name = body.name;

  if (body.phone !== undefined) fields.phone = body.phone;
  if (body.email !== undefined) fields.email = body.email;

  if (body.event_type !== undefined) fields.event_type = body.event_type;
  else if (body.eventType !== undefined) fields.event_type = body.eventType;

  if (body.expected_date !== undefined) fields.expected_date = body.expected_date;
  else if (body.event_date !== undefined) fields.expected_date = body.event_date;
  else if (body.eventDate !== undefined) fields.expected_date = body.eventDate;

  if (body.expected_end_date !== undefined) fields.expected_end_date = body.expected_end_date;
  else if (body.event_end_date !== undefined) fields.expected_end_date = body.event_end_date;
  else if (body.eventEndDate !== undefined) fields.expected_end_date = body.eventEndDate;

  if (body.guest_count !== undefined) fields.guest_count = body.guest_count;
  else if (body.guestCount !== undefined) fields.guest_count = body.guestCount;

  if (body.budget_min !== undefined) fields.budget_min = body.budget_min;
  else if (body.budgetMin !== undefined) fields.budget_min = body.budgetMin;

  if (body.budget_max !== undefined) fields.budget_max = body.budget_max;
  else if (body.budgetMax !== undefined) fields.budget_max = body.budgetMax;
  else if (body.budget !== undefined) fields.budget_max = body.budget;

  if (body.notes !== undefined) fields.notes = body.notes;
  if (body.source !== undefined) fields.source = body.source;

  if (body.priority !== undefined) fields.priority = body.priority;
  if (body.address !== undefined) fields.address = body.address;
  if (body.city !== undefined) fields.city = body.city;

  if (body.hall_section !== undefined) fields.hall_section = body.hall_section;
  else if (body.hallSection !== undefined) fields.hall_section = body.hallSection;

  if (body.assigned_to !== undefined) fields.assigned_to = body.assigned_to;
  else if (body.assignedTo !== undefined) fields.assigned_to = body.assignedTo;

  if (body.lost_reason !== undefined) fields.lost_reason = body.lost_reason;
  else if (body.lostReason !== undefined) fields.lost_reason = body.lostReason;

  if (body.stage !== undefined) fields.status = body.stage;
  else if (body.status !== undefined) fields.status = body.status;

  return fields;
};

const syncEnquiryFollowups = async (enquiry_id, hall_id, user_id, user_name, followups) => {
  if (!Array.isArray(followups)) return;

  for (const f of followups) {
    const isTempId = !f.id || String(f.id).startsWith("fl-") || String(f.id).startsWith("local-");

    const followup_date_val = f.scheduled_at || f.scheduledAt || f.followup_date;
    const method_val = f.type || f.method || "phone";
    const notes_val = f.notes || "";
    const outcome_notes_val = f.outcome || f.outcome_notes || f.outcomeNotes || null;
    const completed_at_val = f.completed_at || f.completedAt || null;
    const status_val = completed_at_val ? "completed" : (f.status || "pending");

    const rowData = {
      enquiry_id,
      hall_id,
      followup_date: followup_date_val ? followup_date_val.split("T")[0] : new Date().toISOString().split("T")[0],
      method: method_val,
      notes: notes_val,
      outcome_notes: outcome_notes_val,
      completed_at: completed_at_val,
      status: status_val,
      updated_at: new Date().toISOString(),
    };

    if (isTempId) {
      await supabaseAdmin.from("enquiry_followups").insert([{
        ...rowData,
        created_by: user_id,
        created_by_name: user_name,
        created_at: new Date().toISOString(),
      }]);
    } else {
      await supabaseAdmin
        .from("enquiry_followups")
        .update(rowData)
        .eq("id", f.id)
        .eq("enquiry_id", enquiry_id);
    }
  }
};

/* ============================================================
   CREATE ENQUIRY
   ============================================================ */
const createEnquiry = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const fields = getEnquiryFields(req.body);
    const { customer_name, phone } = fields;

    if (!customer_name || !phone) {
      return res.status(400).json({ message: "customer_name (or name) and phone are required" });
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

    const enquiry_number = req.body.enquiry_number || req.body.enquiryNumber || await generateEnquiryNumber(hall_id);

    const { data, error } = await supabaseAdmin
      .from("enquiries")
      .insert([{
        ...fields,
        hall_id,
        enquiry_number,
        status: fields.status || "new",
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Handle followup creation / sync
    if (req.body.followups && req.body.followups.length > 0) {
      await syncEnquiryFollowups(data.id, hall_id, req.user.id, req.user.name, req.body.followups);
    } else {
      const followupDate = req.body.followupDate || req.body.followup_date || req.body.scheduledAt || req.body.scheduled_at;
      const followupType = req.body.followupType || req.body.followup_type || req.body.type || req.body.method;
      const followupNotes = req.body.followupNotes || req.body.followup_notes || req.body.notes;

      let followup_date_val;
      if (followupDate) {
        followup_date_val = followupDate.split("T")[0];
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        followup_date_val = tomorrow.toISOString().split("T")[0];
      }

      await supabaseAdmin.from("enquiry_followups").insert([{
        enquiry_id: data.id,
        hall_id,
        followup_date: followup_date_val,
        method: followupType || "phone",
        notes: followupNotes || "Initial followup call",
        created_by: req.user.id,
        created_by_name: req.user.name,
        status: "pending",
      }]);
    }

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "enquiry.created",
      entity_type: "enquiry",
      entity_id: data.id,
      description: `Created enquiry #${enquiry_number} for ${customer_name}`,
      metadata: { enquiry_number },
    });

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
    const rawStatus = req.body.status || req.body.stage;
    const notes = req.body.notes;

    if (!rawStatus) return res.status(400).json({ message: "status (or stage) is required" });
    const status = rawStatus === "converted" ? "booked" : rawStatus;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `Invalid status/stage. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const { data: existing } = await supabaseAdmin
      .from("enquiries")
      .select("id, status, customer_name, enquiry_number")
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

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "enquiry.status_changed",
      entity_type: "enquiry",
      entity_id: id,
      description: `Moved enquiry #${existing.enquiry_number || id} of ${existing.customer_name} from "${existing.status}" to "${status}"`,
      metadata: { from_status: existing.status, to_status: status },
    });

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
    const fields = getEnquiryFields(req.body);

    const { data: existing } = await supabaseAdmin
      .from("enquiries")
      .select("id, status, customer_name, enquiry_number")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ message: "Enquiry not found" });

    if (existing.status === "booked" || existing.status === "lost") {
      return res.status(400).json({ message: `Cannot edit a ${existing.status} enquiry` });
    }

    const { error } = await supabaseAdmin
      .from("enquiries")
      .update(fields)
      .eq("id", id);

    if (error) return res.status(500).json({ message: error.message });

    // Sync followups if provided
    if (req.body.followups && req.body.followups.length > 0) {
      await syncEnquiryFollowups(id, hall_id, req.user.id, req.user.name, req.body.followups);
    }

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "enquiry.updated",
      entity_type: "enquiry",
      entity_id: id,
      description: `Updated enquiry details for #${existing.enquiry_number || id} (${existing.customer_name})`,
      metadata: { updated_fields: Object.keys(fields) },
    });

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
    // Handle camelCase values sent from frontend mapping in convertFormSchema
    const event_date = req.body.eventDate || req.body.event_date;
    const hall_section = req.body.hallSection || req.body.hall_section || "Main Hall";
    const total_amount = req.body.bookingAmount || req.body.booking_amount || req.body.total_amount;
    const advance_amount = req.body.advanceAmount || req.body.advance_amount || 0;
    const notes = req.body.notes || "";
    const event_name = req.body.event_name || req.body.eventName || `${hall_section} - Event`;

    if (!event_date) {
      return res.status(400).json({ message: "eventDate (or event_date) is required" });
    }

    const start_date = event_date;
    const end_date = event_date;

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

    // Create booking with extra frontend fields (hall_section, guest_count, discount_amount = 0)
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
        notes: notes || enquiry.notes,
        hall_section: hall_section,
        guest_count: enquiry.guest_count || 100,
        discount_amount: 0.00,
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
        payment_method: "upi", // default to UPI or map
        payment_date: today,
        notes: `Advance payment — converted from enquiry #${enquiry.enquiry_number || id}`,
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

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "enquiry.converted",
      entity_type: "enquiry",
      entity_id: id,
      description: `Successfully converted enquiry #${enquiry.enquiry_number || id} to booking #${booking.id.slice(0, 8).toUpperCase()}`,
      metadata: { booking_id: booking.id, customer_id },
    });

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