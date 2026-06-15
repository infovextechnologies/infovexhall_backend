const { supabaseAdmin } = require("../config/supabase");
const { logActivity } = require("./activityLogController");

/* ============================================================
   ALLOCATE VENDOR TO BOOKING
   ============================================================ */
const allocateVendor = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hall_id = req.user.hall_id;
    const {
      vendor_id,
      service_type,
      allocated_cost,
      amount_paid,
      payment_status,
      notes,
    } = req.body;

    if (!vendor_id) {
      return res.status(400).json({ message: "vendor_id is required" });
    }

    // 1. Verify booking exists
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, start_date, end_date, event_name, booking_number")
      .eq("id", bookingId)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (bookingError) return res.status(500).json({ message: bookingError.message });
    if (!booking) return res.status(404).json({ message: "Booking not found in your hall" });

    // 2. Verify vendor exists
    const { data: vendor, error: vendorError } = await supabaseAdmin
      .from("vendors")
      .select("id, vendor_name, service_type, status")
      .eq("id", vendor_id)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (vendorError) return res.status(500).json({ message: vendorError.message });
    if (!vendor) return res.status(404).json({ message: "Vendor not found in your hall" });

    if (vendor.status === "blacklisted") {
      return res.status(400).json({ message: "Cannot allocate a blacklisted vendor partner" });
    }

    // 3. Check for double booking conflicts
    const { data: vendorAllocations, error: allocationsError } = await supabaseAdmin
      .from("booking_vendors")
      .select(`
        booking_id,
        bookings ( id, event_name, start_date, end_date, booking_number )
      `)
      .eq("vendor_id", vendor_id)
      .eq("hall_id", hall_id);

    if (allocationsError) return res.status(500).json({ message: allocationsError.message });

    let conflict = false;
    let conflictMessage = "";

    if (vendorAllocations && vendorAllocations.length > 0) {
      const newStart = new Date(booking.start_date).getTime();
      const newEnd = new Date(booking.end_date || booking.start_date).getTime();

      for (const allocation of vendorAllocations) {
        if (!allocation.bookings) continue;
        const existStart = new Date(allocation.bookings.start_date).getTime();
        const existEnd = new Date(allocation.bookings.end_date || allocation.bookings.start_date).getTime();

        // Check date overlap
        if (newStart <= existEnd && newEnd >= existStart) {
          conflict = true;
          conflictMessage = `Vendor "${vendor.vendor_name}" is already assigned to event "${allocation.bookings.event_name}" (${allocation.bookings.booking_number}) on this date (${allocation.bookings.start_date}).`;
          break;
        }
      }
    }

    // Deduce payment status
    const cost = Number(allocated_cost || 0);
    const paid = Number(amount_paid || 0);
    let finalStatus = payment_status || "unpaid";
    if (payment_status === undefined) {
      if (paid >= cost && cost > 0) {
        finalStatus = "paid";
      } else if (paid > 0) {
        finalStatus = "partially_paid";
      } else {
        finalStatus = "unpaid";
      }
    }

    // 4. Save allocation record
    const { data, error } = await supabaseAdmin
      .from("booking_vendors")
      .insert([{
        hall_id,
        booking_id: bookingId,
        vendor_id,
        service_type: service_type || vendor.service_type || "other",
        allocated_cost: cost,
        amount_paid: paid,
        payment_status: finalStatus,
        notes: notes || "",
      }])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ message: "This vendor is already allocated to this booking" });
      }
      return res.status(500).json({ message: error.message });
    }

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.allocated",
      entity_type: "booking",
      entity_id: bookingId,
      description: `Allocated vendor ${vendor.vendor_name} (${service_type || vendor.service_type}) to booking #${booking.booking_number}`,
      metadata: { vendor_id, booking_id: bookingId, cost, conflict },
    });

    res.status(201).json({
      message: conflict 
        ? `Vendor allocated, but a scheduling conflict was detected: ${conflictMessage}`
        : "Vendor allocated to booking successfully",
      data,
      conflict,
      conflictMessage,
    });
  } catch (err) {
    console.error("allocateVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   UPDATE VENDOR ALLOCATION
   ============================================================ */
const updateAllocation = async (req, res) => {
  try {
    const { bookingId, vendorId } = req.params;
    const hall_id = req.user.hall_id;
    const { allocated_cost, amount_paid, payment_status, notes } = req.body;

    // 1. Check if allocation exists
    const { data: existing, error: findError } = await supabaseAdmin
      .from("booking_vendors")
      .select("*, vendors(vendor_name)")
      .eq("booking_id", bookingId)
      .eq("vendor_id", vendorId)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (findError) return res.status(500).json({ message: findError.message });
    if (!existing) return res.status(404).json({ message: "Vendor allocation record not found" });

    const updates = {};
    if (allocated_cost !== undefined) updates.allocated_cost = Number(allocated_cost);
    if (amount_paid !== undefined) updates.amount_paid = Number(amount_paid);
    if (notes !== undefined) updates.notes = notes;

    const cost = allocated_cost !== undefined ? Number(allocated_cost) : Number(existing.allocated_cost || 0);
    const paid = amount_paid !== undefined ? Number(amount_paid) : Number(existing.amount_paid || 0);

    if (payment_status !== undefined) {
      updates.payment_status = payment_status;
    } else if (allocated_cost !== undefined || amount_paid !== undefined) {
      if (paid >= cost && cost > 0) {
        updates.payment_status = "paid";
      } else if (paid > 0) {
        updates.payment_status = "partially_paid";
      } else {
        updates.payment_status = "unpaid";
      }
    }

    updates.updated_at = new Date().toISOString();

    // 2. Perform update
    const { data, error } = await supabaseAdmin
      .from("booking_vendors")
      .update(updates)
      .eq("booking_id", bookingId)
      .eq("vendor_id", vendorId)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.allocation_updated",
      entity_type: "booking",
      entity_id: bookingId,
      description: `Updated allocation details for vendor ${existing.vendors?.vendor_name || vendorId}`,
      metadata: { booking_id: bookingId, vendor_id: vendorId, updates },
    });

    res.json({ message: "Vendor allocation updated successfully", data });
  } catch (err) {
    console.error("updateAllocation error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   DEALLOCATE VENDOR FROM BOOKING
   ============================================================ */
const deallocateVendor = async (req, res) => {
  try {
    const { bookingId, vendorId } = req.params;
    const hall_id = req.user.hall_id;

    // 1. Verify existence
    const { data: existing, error: findError } = await supabaseAdmin
      .from("booking_vendors")
      .select("*, vendors(vendor_name)")
      .eq("booking_id", bookingId)
      .eq("vendor_id", vendorId)
      .eq("hall_id", hall_id)
      .maybeSingle();

    if (findError) return res.status(500).json({ message: findError.message });
    if (!existing) return res.status(404).json({ message: "Vendor allocation record not found" });

    // 2. Delete allocation
    const { error } = await supabaseAdmin
      .from("booking_vendors")
      .delete()
      .eq("booking_id", bookingId)
      .eq("vendor_id", vendorId);

    if (error) return res.status(500).json({ message: error.message });

    // Log Activity
    await logActivity({
      hall_id,
      user_id: req.user.id,
      user_name: req.user.name,
      action: "vendor.deallocated",
      entity_type: "booking",
      entity_id: bookingId,
      description: `Deallocated vendor ${existing.vendors?.vendor_name || vendorId} from booking`,
      metadata: { booking_id: bookingId, vendor_id: vendorId },
    });

    res.json({ message: "Vendor deallocated from booking successfully" });
  } catch (err) {
    console.error("deallocateVendor error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET BOOKING ALLOCATED VENDORS
   ============================================================ */
const getBookingVendors = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("booking_vendors")
      .select(`
        *,
        vendors ( id, vendor_name, phone, service_type, upi_id )
      `)
      .eq("booking_id", bookingId)
      .eq("hall_id", hall_id);

    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    console.error("getBookingVendors error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET VENDOR ALLOCATIONS (Roseter History)
   ============================================================ */
const getVendorAllocations = async (req, res) => {
  try {
    const { id } = req.params; // Vendor ID
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("booking_vendors")
      .select(`
        *,
        bookings ( id, event_name, start_date, end_date, status, booking_number )
      `)
      .eq("vendor_id", id)
      .eq("hall_id", hall_id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    console.error("getVendorAllocations error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================================================
   GET VENDOR ALLOCATION STATS
   ============================================================ */
const getVendorAllocationStats = async (req, res) => {
  try {
    const { id } = req.params; // Vendor ID
    const hall_id = req.user.hall_id;

    const { data, error } = await supabaseAdmin
      .from("booking_vendors")
      .select("allocated_cost, amount_paid")
      .eq("vendor_id", id)
      .eq("hall_id", hall_id);

    if (error) return res.status(500).json({ message: error.message });

    const total_bookings = data?.length || 0;
    const total_earnings = data?.reduce((sum, a) => sum + Number(a.allocated_cost || 0), 0) || 0;
    const total_paid = data?.reduce((sum, a) => sum + Number(a.amount_paid || 0), 0) || 0;
    const total_pending = Math.max(0, total_earnings - total_paid);

    res.json({
      total_bookings,
      total_earnings,
      total_paid,
      total_pending,
    });
  } catch (err) {
    console.error("getVendorAllocationStats error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  allocateVendor,
  updateAllocation,
  deallocateVendor,
  getBookingVendors,
  getVendorAllocations,
  getVendorAllocationStats,
};
