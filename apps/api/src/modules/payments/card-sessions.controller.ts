// The card page's routes (plan docs/plans/4.4-au-card-gateway.md, section 10.1). The session reference is the bearer:
// it travels in the body of view and submit, so it stays out of access logs; only the 3-D Secure return, which the
// gateway sends the customer to, has it in the path. No card field, amount or URL is ever accepted.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CARD_SESSION_REF_PATTERN, cardSubmitSchema, secureFieldsAuthoriseSchema, secureFieldsSubmitSchema } from '@mt/shared';
import { Public } from '../../platform/access/access.decorators';
import { ZodPipe } from '../../platform/http/zod.pipe';
import type { ApiRequest } from '../../platform/http/request-context';
import { CardSessionsService } from './core/card-sessions/card-sessions.service';

const refSchema = z.object({ ref: z.string().regex(CARD_SESSION_REF_PATTERN) }).strict();
const submitSchema = cardSubmitSchema.extend({ ref: z.string().regex(CARD_SESSION_REF_PATTERN) }).strict();
const secureSubmitSchema = secureFieldsSubmitSchema.extend({ ref: z.string().regex(CARD_SESSION_REF_PATTERN) }).strict();
const secureAuthoriseSchema = secureFieldsAuthoriseSchema.extend({ ref: z.string().regex(CARD_SESSION_REF_PATTERN) }).strict();

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

@Controller('payments/card-sessions')
export class CardSessionsController {
  constructor(@Inject(CardSessionsService) private readonly sessions: CardSessionsService) {}

  @Post('view') @HttpCode(200)
  @Public('card session holders: status, amount and currency of the session; the gateway publishable key while it is open')
  view(@Body(new ZodPipe(refSchema)) b: z.infer<typeof refSchema>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.sessions.view(b.ref);
  }

  @Post('submit') @HttpCode(200)
  @Public('card session holders: submit the gateway single-use card token once; the amount is the session\'s')
  submit(@Body(new ZodPipe(submitSchema)) b: z.infer<typeof submitSchema>, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.sessions.submit(b.ref, b.cardToken, req.ip);
  }

  /** Task 9.1: eWAY's card page sends its Secure Fields code once; the answer starts 3-D Secure (no money moves). */
  @Post('secure-fields/submit') @HttpCode(200)
  @Public('card session holders: submit the gateway single-use Secure Fields code once to start 3-D Secure; the amount is the session\'s')
  secureSubmit(@Body(new ZodPipe(secureSubmitSchema)) b: z.infer<typeof secureSubmitSchema>, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.sessions.submit(b.ref, b.secureFieldCode, req.ip, 'before_charge');
  }

  /** Task 9.1: after eWAY's 3-D Secure challenge, the one charge of the session (plan 9.1, section 6.4). */
  @Post('secure-fields/authorise') @HttpCode(200)
  @Public('card session holders: after 3-D Secure, charge the session once with the authenticated card; the amount is the session\'s')
  secureAuthorise(@Body(new ZodPipe(secureAuthoriseSchema)) b: z.infer<typeof secureAuthoriseSchema>, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.sessions.authorise(b.ref, b.accessCode, b.secureFieldCode, req.ip);
  }

  /** Where the gateway sends the customer after 3-D Secure: always on to the session's own return page. */
  @Get(':ref/authenticated')
  @Public('customers back from 3-D Secure: a redirect to the session\'s return page, nothing else')
  async authenticated(@Param('ref') ref: string, @Query('session_token') sessionToken: string | undefined, @Req() req: ApiRequest, @Res() res: Response): Promise<void> {
    noStore(res);
    const to = await this.sessions.authenticated(ref, typeof sessionToken === 'string' ? sessionToken : undefined, req.ip);
    res.redirect(303, to);
  }
}
