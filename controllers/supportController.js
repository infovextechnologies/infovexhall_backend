const { supabaseAdmin } = require("../config/supabase");
const { createNotification } = require("./notificationController");

// ─────────────────────────────────────────────────────────────────────────────
// CREATE TICKET
// ─────────────────────────────────────────────────────────────────────────────
const createTicket = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;
    const { subject, description, category = "bug", priority = "medium" } = req.body;

    if (!subject || !description) {
      return res.status(400).json({ message: "Subject and description are required" });
    }

    // 1. Fetch Hall Name
    const { data: hall } = await supabaseAdmin
      .from("marriage_halls")
      .select("hall_name")
      .eq("id", hall_id)
      .single();

    const hallName = hall?.hall_name || "Unknown Venue";

    // 2. Generate Ticket Number
    const { count } = await supabaseAdmin
      .from("support_tickets")
      .select("id", { count: "exact", head: true });
    const nextNum = 1000 + (count || 0) + 1;
    const ticket_number = `TIC-${nextNum}`;

    // 3. Create Ticket
    const { data: ticket, error } = await supabaseAdmin
      .from("support_tickets")
      .insert([{
        ticket_number,
        hall_id,
        subject,
        description,
        category,
        priority,
        status: "open",
        messages: [{
          sender: "user",
          senderName: req.user.name || "Venue Owner",
          message: description,
          timestamp: new Date().toISOString(),
        }],
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // 4. Create Notification for Super Admin
    await createNotification({
      hall_id: null, // super admin
      type: "support_ticket_new",
      title: "New Support Ticket",
      message: `Ticket ${ticket_number} created by ${hallName}: ${subject}`,
      entity_type: "support_ticket",
      entity_id: ticket.id,
    });

    res.status(201).json({
      message: "Ticket created successfully",
      ticket: {
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        hallId: ticket.hall_id,
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        messages: ticket.messages,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
      },
    });
  } catch (err) {
    console.error("createTicket error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL TICKETS FOR VENUE
// ─────────────────────────────────────────────────────────────────────────────
const getTickets = async (req, res) => {
  try {
    const hall_id = req.user.hall_id;

    const { data: tickets, error } = await supabaseAdmin
      .from("support_tickets")
      .select("*")
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });

    const formatted = (tickets || []).map((t) => ({
      id: t.id,
      ticketNumber: t.ticket_number,
      hallId: t.hall_id,
      subject: t.subject,
      description: t.description,
      category: t.category,
      priority: t.priority,
      status: t.status,
      assignedTo: t.assigned_to || "Unassigned",
      messages: t.messages || [],
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("getTickets error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TICKET BY ID
// ─────────────────────────────────────────────────────────────────────────────
const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;

    const { data: ticket, error } = await supabaseAdmin
      .from("support_tickets")
      .select("*")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (error) return res.status(500).json({ message: error.message });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    res.json({
      id: ticket.id,
      ticketNumber: ticket.ticket_number,
      hallId: ticket.hall_id,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      assignedTo: ticket.assigned_to || "Unassigned",
      messages: ticket.messages || [],
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
    });
  } catch (err) {
    console.error("getTicketById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD TICKET REPLY MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
const addTicketMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const hall_id = req.user.hall_id;
    const { message } = req.body;

    if (!message) return res.status(400).json({ message: "Message is required" });

    // 1. Fetch ticket and verify owner
    const { data: ticket, error: fetchErr } = await supabaseAdmin
      .from("support_tickets")
      .select("*, marriage_halls(hall_name)")
      .eq("id", id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ message: fetchErr.message });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    const hallName = ticket.marriage_halls?.hall_name || "Unknown Venue";

    // 2. Append Message
    const messages = ticket.messages || [];
    messages.push({
      sender: "user",
      senderName: req.user.name || "Venue Owner",
      message,
      timestamp: new Date().toISOString(),
    });

    // 3. Update Ticket (Set status back to open if it was resolved)
    const updates = {
      messages,
      updated_at: new Date().toISOString(),
    };
    if (ticket.status === "resolved") {
      updates.status = "open";
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("support_tickets")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ message: updateErr.message });

    // 4. Create Notification for Super Admin
    await createNotification({
      hall_id: null,
      type: "support_ticket_message",
      title: `Reply on Ticket ${ticket.ticket_number}`,
      message: `Reply from ${hallName}: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`,
      entity_type: "support_ticket",
      entity_id: ticket.id,
    });

    res.json({
      message: "Message reply added successfully",
      ticket: {
        id: updated.id,
        ticketNumber: updated.ticket_number,
        hallId: updated.hall_id,
        subject: updated.subject,
        description: updated.description,
        category: updated.category,
        priority: updated.priority,
        status: updated.status,
        messages: updated.messages,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    console.error("addTicketMessage error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createTicket,
  getTickets,
  getTicketById,
  addTicketMessage,
};
