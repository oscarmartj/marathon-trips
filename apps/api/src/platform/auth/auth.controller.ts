import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  enrolmentCompleteSchema, magicLinkRequestSchema, staffMfaSchema, staffSignInSchema, stepUpSchema, tokenBodySchema,
} from '@mt/shared';
import type { Response } from 'express';
import { OwnedBy, Public } from '../access/access.decorators';
import { AccessService, STEP_UP_WINDOW_MS } from '../access/access.service';
import { sessionOf } from '../access/actor';
import { PrismaService } from '../database/prisma.service';
import { RequiresFlag } from '../flags/requires-flag.guard';
import { FLAGS } from '../flags/flag-registry';
import { unauthorised } from '../http/api-error';
import { AuthRateLimit } from '../http/rate-limit.guard';
import type { ApiRequest } from '../http/request-context';
import { ZodPipe } from '../http/zod.pipe';
import { clearCookie, readCookie, setCookie } from './cookies';
import { CustomerAuthService } from './customer-auth.service';
import { requestMeta } from './request-meta';
import { SessionService } from './session.service';
import { StaffAuthService } from './staff-auth.service';

/**
 * Sign-in routes. One-time tokens travel only in JSON bodies or in the staff MFA cookie, never in a path or query
 * (they reach the browser in a URL fragment, which servers never see).
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(StaffAuthService) private readonly staff: StaffAuthService,
    @Inject(CustomerAuthService) private readonly customers: CustomerAuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private get secure(): boolean {
    return this.sessions.secureCookies;
  }

  // ---- Staff ----

  @Post('staff/sign-in')
  @HttpCode(200)
  @Public('password check; on success only a short-lived second-factor step cookie, never a session')
  @AuthRateLimit()
  async staffSignIn(@Body(new ZodPipe(staffSignInSchema)) body: { email: string; password: string }, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const step = await this.staff.signIn(body.email, body.password, req.requestId);
    setCookie(res, 'staff_mfa', this.secure, step.mfaToken, step.maxAgeSeconds);
    return { next: 'second_factor' };
  }

  @Post('staff/sign-in/second-factor')
  @HttpCode(200)
  @Public('second-factor check for the holder of the step cookie; creates the staff session')
  @AuthRateLimit()
  async staffSecondFactor(@Body(new ZodPipe(staffMfaSchema)) body: { code?: string; recoveryCode?: string }, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const session = await this.staff.verifySecondFactor(readCookie(req, 'staff_mfa', this.secure), body, requestMeta(req), req.requestId);
    clearCookie(res, 'staff_mfa', this.secure);
    setCookie(res, 'staff', this.secure, session.token, session.maxAgeSeconds);
    return { signedIn: true };
  }

  @Post('staff/step-up')
  @HttpCode(200)
  @OwnedBy({ kind: 'staff', resource: 'self' })
  @AuthRateLimit()
  async stepUp(@Body(new ZodPipe(stepUpSchema)) body: { code: string }, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const auth = sessionOf(req);
    const r = await this.staff.stepUp(auth.userId, auth.sessionId, body.code, req.requestId);
    if (r.ok) return { stepUpValidUntil: new Date(Date.now() + STEP_UP_WINDOW_MS).toISOString() };
    if (r.revoked) clearCookie(res, 'staff', this.secure);
    throw unauthorised(r.revoked ? 'session_revoked' : 'invalid_code', r.revoked ? 'Too many wrong codes. Sign in again.' : 'That code is not right');
  }

  @Get('staff/session')
  @OwnedBy({ kind: 'staff', resource: 'self' })
  async staffSession(@Req() req: ApiRequest) {
    const auth = req.auth!;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true } });
    const eff = await this.access.effective(this.prisma, auth.userId);
    const until = auth.mfaVerifiedAt ? new Date(auth.mfaVerifiedAt.getTime() + STEP_UP_WINDOW_MS) : null;
    return {
      userId: user.id, email: user.email, isOwner: eff.isOwner, permissions: [...eff.keys].sort(),
      stepUpValidUntil: until && until > new Date() ? until.toISOString() : null,
    };
  }

  @Post('staff/sign-out')
  @HttpCode(200)
  @OwnedBy({ kind: 'staff', resource: 'self' })
  async staffSignOut(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    await this.staff.signOut(sessionOf(req), req.requestId);
    clearCookie(res, 'staff', this.secure);
    return { signedOut: true };
  }

  @Post('staff/enrolment/start')
  @HttpCode(200)
  @Public('holder of a set-up link sees the account email and a new authenticator secret; does not consume the link')
  @AuthRateLimit()
  async enrolmentStart(@Body(new ZodPipe(tokenBodySchema)) body: { token: string }) {
    return this.staff.startEnrolment(body.token);
  }

  @Post('staff/enrolment/complete')
  @HttpCode(200)
  @Public('holder of a set-up link sets the password and confirms the authenticator; consumes the link')
  @AuthRateLimit()
  async enrolmentComplete(@Body(new ZodPipe(enrolmentCompleteSchema)) body: { token: string; password: string; code: string }, @Req() req: ApiRequest) {
    return this.staff.completeEnrolment(body.token, body.password, body.code, req.requestId);
  }

  // ---- Customers ----

  @Post('customer/magic-link')
  @HttpCode(202)
  @Public('asks for a sign-in email; same answer whether or not the address has an account')
  @RequiresFlag(FLAGS.customerSignIn)
  @AuthRateLimit()
  async magicLink(@Body(new ZodPipe(magicLinkRequestSchema)) body: { email: string }, @Req() req: ApiRequest) {
    await this.customers.requestLink(body.email, req.requestId);
    return { status: 'sent' };
  }

  @Post('customer/magic-link/inspect')
  @HttpCode(200)
  @Public('holder of a sign-in link sees which address it is for; does not consume it')
  @RequiresFlag(FLAGS.customerSignIn)
  @AuthRateLimit()
  async magicLinkInspect(@Body(new ZodPipe(tokenBodySchema)) body: { token: string }) {
    return this.customers.inspect(body.token);
  }

  @Post('customer/magic-link/verify')
  @HttpCode(200)
  @Public('holder of a sign-in link consumes it and gets a customer session')
  @RequiresFlag(FLAGS.customerSignIn)
  @AuthRateLimit()
  async magicLinkVerify(@Body(new ZodPipe(tokenBodySchema)) body: { token: string }, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const session = await this.customers.verify(body.token, requestMeta(req), req.requestId);
    setCookie(res, 'customer', this.secure, session.token, session.maxAgeSeconds);
    return { signedIn: true };
  }

  @Get('customer/session')
  @OwnedBy({ kind: 'customer', resource: 'self' })
  async customerSession(@Req() req: ApiRequest) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { id: true, email: true } });
    return { userId: user.id, email: user.email };
  }

  @Post('customer/sign-out')
  @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'self' })
  async customerSignOut(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    await this.customers.signOut(sessionOf(req), req.requestId);
    clearCookie(res, 'customer', this.secure);
    return { signedOut: true };
  }
}
