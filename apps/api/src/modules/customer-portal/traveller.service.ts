import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { BookingStatus, BookingTravellersView, TravellerDetailsInput, TravellerView } from '@mt/shared';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AuditService } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { dbNow, todayInBrisbane } from '../bookings';
import type { Prisma } from '../../generated/prisma/client';
import { type EditWindow, TRAVELLER_SETTINGS, editWindow } from './traveller-window';

type Tx = Prisma.TransactionClient;
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export const defineTravellerSettings = (settings: SettingsService): void =>
  settings.define(TRAVELLER_SETTINGS.cutoffDays.key, z.number().int().min(0).max(120), 1, {
    description: 'Days before the race start by which customers can no longer change traveller details, when staff have set no entry submission date for the edition',
  });

interface PlaceRow {
  slot: number;
  participationType: 'runner_with_entry' | 'runner_own_entry' | 'supporter';
  isLead: boolean;
  details: { givenName: string; familyName: string; dateOfBirth: Date | null; emergencyContactName: string | null; emergencyContactPhone: string | null; estimatedFinishSeconds: number | null } | null;
}

const isRunner = (p: PlaceRow['participationType']): boolean => p !== 'supporter';

/** A place is complete when the entry has what it needs: a name, and a date of birth for a runner. */
const isComplete = (p: PlaceRow): boolean => !!p.details && p.details.givenName !== '' && (!isRunner(p.participationType) || p.details.dateOfBirth !== null);

function viewOf(places: PlaceRow[], window: EditWindow): BookingTravellersView {
  return {
    ...window,
    travellers: places.map((p): TravellerView => ({
      slot: p.slot, participationType: p.participationType, isLead: p.isLead, runner: isRunner(p.participationType),
      details: p.details && {
        givenName: p.details.givenName, familyName: p.details.familyName, dateOfBirth: day(p.details.dateOfBirth),
        emergencyContactName: p.details.emergencyContactName, emergencyContactPhone: p.details.emergencyContactPhone, estimatedFinishSeconds: p.details.estimatedFinishSeconds,
      },
      complete: isComplete(p),
    })),
  };
}

/**
 * Traveller details (task 5.2, plan docs/plans/5.2-traveller-details.md). Ownership is checked by the routes' guards
 * before anything here runs. The edit window is decided here, on the database clock, inside the transaction that
 * writes: a save that arrives after the deadline is refused whatever the browser showed.
 */
@Injectable()
export class TravellerDetailsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  private async windowOf(tx: Tx, booking: { status: BookingStatus; editionId: string }, at: Date): Promise<EditWindow> {
    const [edition, key, cutoffDays] = await Promise.all([
      tx.raceEdition.findUnique({ where: { id: booking.editionId }, select: { startDate: true } }),
      tx.keyDate.findFirst({ where: { editionId: booking.editionId, kind: 'entry_submission' }, select: { dueDate: true } }),
      this.settings.get<number>(TRAVELLER_SETTINGS.cutoffDays.key, TRAVELLER_SETTINGS.cutoffDays.fallback),
    ]);
    return editWindow({ status: booking.status, entrySubmissionDate: day(key?.dueDate ?? null), raceStartDate: day(edition?.startDate ?? null), cutoffDays, today: todayInBrisbane(at) });
  }

  /** The places of a booking in order, each with its details (two reads: the places belong to bookings, the details to this module). */
  private async placesOf(tx: Tx, bookingId: string): Promise<PlaceRow[]> {
    const [places, details] = await Promise.all([
      tx.bookingTraveller.findMany({ where: { bookingId, removedInVersion: null }, orderBy: { slot: 'asc' }, select: { slot: true, participationType: true, isLead: true } }),
      tx.traveller.findMany({ where: { bookingId }, select: { slot: true, givenName: true, familyName: true, dateOfBirth: true, emergencyContactName: true, emergencyContactPhone: true, estimatedFinishSeconds: true } }),
    ]);
    const bySlot = new Map(details.map(({ slot, ...d }) => [slot, d]));
    return places.map((p) => ({ ...p, details: bySlot.get(p.slot) ?? null }));
  }

  /** The places of a booking, their details and whether they can still be changed. */
  async view(reference: string): Promise<BookingTravellersView> {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { reference }, select: { id: true, status: true, editionId: true } });
      if (!booking) throw notFound();
      const at = await dbNow(tx);
      return viewOf(await this.placesOf(tx, booking.id), await this.windowOf(tx, booking, at));
    });
  }

  /** Replaces the details of one place. */
  save(actor: AuditActor, reference: string, slot: number, input: TravellerDetailsInput): Promise<BookingTravellersView> {
    return this.write(actor, reference, slot, input);
  }

  /** Removes the details of one place (idempotent). */
  clear(actor: AuditActor, reference: string, slot: number): Promise<BookingTravellersView> {
    return this.write(actor, reference, slot, null);
  }

  private async write(actor: AuditActor, reference: string, slot: number, input: TravellerDetailsInput | null): Promise<BookingTravellersView> {
    return this.prisma.$transaction(async (tx) => {
      // The customer and then the booking are locked for share (the order erasure uses: Customer, Booking, Traveller), and the
      // customer must still be open: the guard checked that before this transaction, so an erasure may have committed since.
      // The booking lock keeps its status from changing under the save; the place row serialises two saves of one place.
      const [booking] = await tx.$queryRaw<Array<{ id: string; customerId: string; status: BookingStatus; editionId: string }>>`
        SELECT b.id, b."customerId", b.status, b."editionId" FROM bookings b JOIN customers c ON c.id = b."customerId"
        WHERE b.reference = ${reference} AND c."deletedAt" IS NULL AND c."anonymisedAt" IS NULL FOR SHARE OF c, b`;
      if (!booking) throw notFound();
      const [place] = await tx.$queryRaw<Array<{ id: string; participationType: PlaceRow['participationType'] }>>`
        SELECT id, "participationType" FROM booking_travellers WHERE "bookingId" = ${booking.id}::uuid AND slot = ${slot} AND "removedInVersion" IS NULL FOR UPDATE`;
      if (!place) throw notFound();
      const at = await dbNow(tx);
      const window = await this.windowOf(tx, booking, at);
      if (!window.editable) throw conflict('travellers_not_editable', window.reason === 'deadline_passed' ? 'The deadline for changing traveller details has passed' : 'Traveller details cannot be changed for this booking now');

      const existing = await tx.traveller.findUnique({ where: { bookingId_slot: { bookingId: booking.id, slot } } });
      const snapshot = (r: NonNullable<typeof existing>) => ({
        customerId: r.customerId, bookingId: r.bookingId, slot: r.slot, givenName: r.givenName, familyName: r.familyName, dateOfBirth: day(r.dateOfBirth),
        emergencyContactName: r.emergencyContactName, emergencyContactPhone: r.emergencyContactPhone, estimatedFinishSeconds: r.estimatedFinishSeconds,
      });

      if (input === null) {
        if (existing) {
          await tx.traveller.delete({ where: { id: existing.id } });
          await this.audit.record(tx, { actor, action: 'customerPortal.traveller.cleared', entityType: 'Traveller', entityId: existing.id, model: 'Traveller', before: snapshot(existing) });
        }
      } else {
        const runner = isRunner(place.participationType);
        if (!runner && (input.dateOfBirth != null || input.estimatedFinishSeconds != null)) {
          throw unprocessable('not_asked_for_supporters', 'A date of birth and a finish time are only asked for runners');
        }
        if (input.dateOfBirth != null && input.dateOfBirth > todayInBrisbane(at)) throw unprocessable('invalid_date_of_birth', 'The date of birth cannot be in the future');
        const data = {
          givenName: input.givenName, familyName: input.familyName,
          dateOfBirth: input.dateOfBirth ? new Date(`${input.dateOfBirth}T00:00:00.000Z`) : null,
          emergencyContactName: input.emergencyContactName ?? null, emergencyContactPhone: input.emergencyContactPhone ?? null,
          estimatedFinishSeconds: input.estimatedFinishSeconds ?? null,
        };
        const saved = existing
          ? await tx.traveller.update({ where: { id: existing.id }, data })
          : await tx.traveller.create({ data: { ...data, bookingId: booking.id, customerId: booking.customerId, slot } });
        await this.audit.record(tx, {
          actor, action: 'customerPortal.traveller.saved', entityType: 'Traveller', entityId: saved.id, model: 'Traveller',
          ...(existing ? { before: snapshot(existing) } : {}), after: snapshot(saved),
        });
      }
      return viewOf(await this.placesOf(tx, booking.id), window);
    });
  }
}
