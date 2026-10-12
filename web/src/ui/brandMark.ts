// The Lampo identity as geometry: one source for the app (BrandMark / Wordmark in ui/icons.tsx), the app icons
// (scripts/icons.ts) and docs/brand/. No DOM, no React. From the approved brand kit (2026-09-29, "out of the o, a
// frame"); change the kit first, then this file (its paths packed with packPath), then run scripts/icons.ts.
// Units: Norican at size 200, baseline y = 0. "lamp" is Norican outlines (SIL Open Font License 1.1,
// docs/brand/OFL-Norican.txt); the last letter is a frame drawn with the same pen: a slanted superellipse ring (thick
// sides, thin top and bottom) that keeps Norican's own o exit stroke. Its window is the brand orange.

// The name lives in lib/ because the server says it too (notifications, OAuth, the MCP server's title).
export { BRAND_NAME } from '../../../lib/brand.ts';
/** The window's orange; in CSS it is the `--brand` token (base.css). */
export const BRAND_ORANGE = '#f25a1d';

// The paths ride packed: the logo is in the library's first paint, and written out its numbers cost 6 KB of it gzipped
// (the frame o is a ring of 1,000 points). A number is kept in hundredths as the change of its axis's step (x and y
// take turns): the outlines and the ring are smooth, so most take a character or two. `unpackPath` writes the path out
// as the kit has it, byte for byte (test/unit/brand.test.ts holds it to docs/brand/); `packPath` packs a new kit's.
/** What a path says between its numbers. */
const CMD = 'MLHVCSQTAZ';
/** Printable ASCII but commands and quotes: the first half ends a number, the second half says more digits follow. */
const DIGIT = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i))
  .filter((c) => !CMD.includes(c) && !`'"\`\\`.includes(c))
  .join('');
const BASE = DIGIT.length / 2;
/** Each character's digit by its code; -1 for a command (unpackPath runs before the first paint: no searching). */
const VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < DIGIT.length; i++) VALUE[DIGIT.charCodeAt(i)] = i;

/** A number in hundredths as the kit writes it: `fixed` keeps both decimals (Norican's outlines, all but 0), else the
 * shortest. */
function kitNumber(v: number, fixed: boolean): string {
  const a = v < 0 ? -v : v;
  const cents = a % 100;
  const whole = `${v < 0 ? '-' : ''}${(a - cents) / 100}`;
  if (fixed && v) return `${whole}${cents < 10 ? '.0' : '.'}${cents}`;
  if (!cents) return whole;
  return cents % 10 ? `${whole}${cents < 10 ? '.0' : '.'}${cents}` : `${whole}.${cents / 10}`;
}

/** A packed path written out. `fixed`: the lettering's way — both decimals, no space before a minus; else the frame's,
 * the shortest numbers, a space between every two. */
export function unpackPath(packed: string, fixed: boolean): string {
  const at = [0, 0];
  const step = [0, 0];
  let out = '';
  let axis = 0;
  let z = 0;
  let after = false;
  for (let i = 0; i < packed.length; i++) {
    const d = VALUE[packed.charCodeAt(i)];
    if (d < 0) {
      out += packed[i];
      after = false;
      continue;
    }
    z = z * BASE + (d % BASE);
    if (d >= BASE) continue;
    step[axis] += z % 2 ? -(z + 1) / 2 : z / 2;
    at[axis] += step[axis];
    const n = kitNumber(at[axis], fixed);
    out += (after ? (fixed && n[0] === '-' ? '' : ' ') : '') + n;
    axis ^= 1;
    z = 0;
    after = true;
  }
  return out;
}

/** A path of absolute commands and numbers with at most two decimals, packed for `unpackPath`. */
export function packPath(path: string): string {
  const at = [0, 0];
  const step = [0, 0];
  let axis = 0;
  let out = '';
  for (const tok of path.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? []) {
    if (/[A-Za-z]/.test(tok)) {
      if (!CMD.includes(tok)) throw new Error(`packPath: absolute commands only, not ${tok}`);
      out += tok;
      continue;
    }
    const v = Math.round(Number(tok) * 100);
    const d = v - at[axis];
    let z = d - step[axis];
    z = z < 0 ? -2 * z - 1 : 2 * z;
    step[axis] = d;
    at[axis] = v;
    axis ^= 1;
    let digits = DIGIT[z % BASE];
    for (z = Math.floor(z / BASE); z; z = Math.floor(z / BASE)) digits = DIGIT[BASE + (z % BASE)] + digits;
    out += digits;
  }
  return out;
}

/** "lamp": the lettering, one path. */
export const LOGO_LETTERS = /* @__PURE__ */ unpackPath(
  'MR})e)LR}(e(QlO!cBiDQ#!];^#Q!!R?UNL!nJQ!RnOb?]OQ!#_/>Q!!]&]&Q##XJe5Q$#U;l9Q$#7tEL{(!Qw-!e*m+Q!$i#b5L!x>Q!Rm!i.W2Q!!a,[FQ#!W:_#Q#$W?b@Q!!a+e(Q$!i/gFL!!Q!!U4k7Q$!.[;Q!!U?^#L!j#Q!YGU+^9Q!!a7e2Lc>!Q]/!f+j6Q##[Ga,Q!$,R,Q!!^#]9LkOn5L!Re?QU_0Rb-s$Ri:Q!!_&R]0ZMWc-]zILUP#]zJQRX5RP#a.a@Q$$a@.Q#$b(_7Q#!c*k!L!l7Q!c*W4U>Q$!a@eJLe)!Qs0!U-R[JQ##*RP9Q!!W4y+ZMYy3Xy/LYX:]zIQu@!e1k6Q$!a7^.Q!!YGW3L!p3Q!Re*p=NQ#$j1_7Q#!d5h9Q!$[;q&LRoK!QlN!U2X=Q!#R5U-LkO[FQOYGXFjEQ!!RKa!Q##/R$Q!#U3]8Q!!Y)gDL!c,Q!v-e=v,Le<!Qd+!_7i%Q!$[;b@Q!$UNYILw,z=L!Rg)Qb@RROa4^$Q!$Y<U=Q!!*UKQ#$WN^%Q!!_7dILe=!QlO!e5j@Q##];X:L!o3Q!c>R--Q#!-U?LR4_BQjOpG]F$Q$#XI^OQ#!RIgFZMUv/R}%LR{<R}&Qf)!X)b,Q#!*XFQ!!YFRNLd*e)LRg)[P,QUh*[P-W5m!Q$#^-d5Q!!c+YGQ!!h&U<L!}:Q!s/a7YFQ!$g1m6ZMjb!R~&Lj|FR~%QsD!sERUOL!RW!Q!x<a-3Q!$W+R-Q##W(BQ!!a,R5L!tEQ!c>^OR-Q#!Y%b5Le)!Qp2!R!q&Q#!U7e5Q!!W;X&Q$$Y;[2Q!$[GhFLYGk6LUd@!QUdBR^Fc+RBQ!!UN5Q!![FBL^.RYJQNUIK#Q!$!NL!RNQ!e*]#[JQ##R>]1L^E!QX0!R8U!LYJROQr0c=W+h3Q!!W3_-Q!!X;R+Q$$Y1[0Q!#YJf%LXGj#LUd.!QUeElKX;gIQ!$W)]0Q$!RNR-Q##/_$Q#$>j-La@g;Q_Bg:cBcJQ#$n5W=LRYI!Q^DRX5]8R5Q!!X)UKLc+RUKQg;sD[&XIQ!!Y1W?Q$#XGb!Q!!X)j$L|%!Qe=![:b7Q$#X>W?Q!!W2W4L!b>Q!wB^.5Q!!KUKL_-u,Qf;v,^;U>Q#$Y=X1Q#!W-b!Q#!,i9Lw>!Qw-!l#l7Q$#b,aEL!w,Q!w?[:RBQ!#U2X0Q##R?_6Q$$[/f*LR!Y0Q4X3.@Q!!BR*L!U4Q!aBYJa@LYI!Qc=!k9w>Q$#e;e:LR]FR]1L!Rf+QnKr2]DUBQ$#8X(Q!$YJ_DQ!!d)g:ZMXs!X{/L[m>X{.QUy/Uc.]:X2Q!$UJNQ$#c3[3Ly(U_1QaBrD]&m)Q#$_$Y;LqF!LwB!QRi(U^3RK5Lr1U^FQd+qF_N[%Q$![1U3Q!$W=a?Q!$6jBLw>!Qx?!j#l!Q!!e<b+L!w*Q!w-c*[EQ!!^#>Q##XF],Q!#>eILpGg%Qc+!WJW<Q$#^7b(Q!#c5i8Q!!h&q:LRe*Rk$L!Rg)QRb@N^$f0Q!!R>iDQ!!b@mKLRh)!Qh%!b-^#Q!!YGY(L!d+Q!d(c?U@Q!$N+Ld<f=Qi9l4R?e>Q$![2RIQ!#dIa-L!rGQ!i8]8]EQ!$_8a?Lh&!QsD!W3o)Q!!W5g)Q#!W+_-Q!!W+R-Lf;RaDLd*RU!Q[0oGY)a*Q!![&q0L^/u.Z',
  true,
);
/** The frame o: ring (even-odd), its window (the orange), and the o's exit stroke. */
export const FRAME_RING = /* @__PURE__ */ unpackPath(
  'MRfu!Y]6LRf}O[XJLYEo,LEW2L3R>L+R%L)@L&:L&2L$2L$.L$,L!,L$(L!*L!(L!(L$%L#(L!%L!(L!#L!%L!#L#%L!%L!#L!#L#%L!#L!#L##L!#L!%L#!L!%L!!L#%L#!L!#L!#L##L!#L##L#!L$#L%#L!#L##L!!L##L##L!!L##L##L!!L#%L#$L#%L#!L##L!!L%#L!#L%!L##L##L%!L##L#!L%#L##L(!L##L(!L%#L%#L*!L%#L,!L(#L.!L,#L0#L2!L8#L@#LR#!LR:!LW.#Ln4#L$!Ln3#LW/#LR=!LR&!L?#L9#L7!L/#L/#L-!L-#L+!L)#L+!L&#L)#L)!L&#L&!L$#L)#L&!L$#L&!L$#L&#L$!L$#L&#L$!L&#L!!L&%L!$L&%L$!L$#L$#L$!L&#L!#L$!L$#L$#L!#L&#L$!L$#L!#L$#L&#L!#L$!L$%L$!L$%L!!L&%L!#L&#L!#L$#L$%L$#L$#L$%L$%L!#L&%L$#L$(L$%L$(L&%L!(L&(L&*L$(L$,L),L$.L)2L&2L+:L)@L1R%L3R>LJW2LYEo,L$!LYDo-LDW3L2R?L*R&L(BL%;L%3L#3L#/L#-L!-L#)L!+L!)L!)L#&L$)L!&L!)L!$L!&L!$L$&L!&L!$L!$L$&L!$L!$L$$L!$L!&L$!L!&L!!L$&L$!L!$L!$L$$L!$L$$L$!L#$L&$L!$L$$L!!L$$L$$L!!L$$L$$L!!L$&L$#L$&L$!L$$L!!L&$L!$L&!L$$L$$L&!L$$L$!L&$L$$L)!L$$L)!L&$L&$L+!L&$L-!L)$L/!L-$L1$L3!L9$LB$LR$!LR;!LW/$Ln5$L#!Ln2$LW.$LR<!LR%!L>$L8$L6!L.$L.$L,!L,$L*!L($L*!L%$L($L(!L%$L%!L#$L($L%!L#$L%!L#$L%$L#!L#$L%$L#!L%$L!!L%&L!#L%&L#!L#$L#$L#!L%$L!$L#!L#$L#$L!$L%$L#!L#$L!$L#$L%$L!$L#!L#&L#!L#&L!!L%&L!$L%$L!$L#$L#&L#$L#$L#&L#&L!$L%&L#$L#)L#&L#)L%&L!)L%)L%+L#)L#-L(-L#/L(3L%3L*;L(BL0R&L2R?LIW3ZMUb>W.LUh3k<L:U=L2R/L*JL(;L%5L(1L%/L#-L#-L%)L#)L#+L#&L!&L%)L#$L!)L#$L#&L!$L#&L#&L#!L!&L#$L#$L!$L#$L!&L#!L#$L!$L#$L!$L#$L#$L!!L#$L#$L!$L!!L#&L#!L#!L!&L#!L!!L#&L!!L%!L!&L!!L#!L#&L#!L!!L#$L#$L#!L!$L%$L!!L#!L#&L!!L%!L#$L#$L#!L#!L%&L#!L%!L#$L%$L%!L%!L%&L(#L*&L(#L,&L.!L0!L8$LF$LR<!La0$L#!La3$LR;!LG$L9$L/!L1!L+&L)#L)&L)#L&&L&!L$!L&$L$$L&!L$!L!&L&!L$!L!$L$$L$!L$!L!&L$!L!!L$$L!$L$!L!$L$$L!!L$!L!&L!!L$!L!&L!!L$!L!&L!!L$!L!&L!!L!!L$&L!!L!$L!$L$$L!!L!$L!$L!$L$$L!$L#$L$!L$&L#$L!$L$$L#$L$&L#!L$&L!&L#$L$&L#$L$)L#$L!)L!&L!&L#+L!)L#)L!-L#-L%/L#1L#5L(;L*JL.R/L<U=LWKgBL!!LX$g@L;U<L3R.L+IL):L&4L)0L&.L$,L$,L&(L$(L$*L$%L!%L&(L$#L!(L$#L$%L!#L$%L$%L$!L!%L$#L$#L!#L$#L!%L$!L$#L!#L$#L!#L$#L$#L!!L$#L$#L!#L!!L$%L$!L$!L!%L$!L!!L$%L!!L&!L!%L!!L$!L$%L$!L!!L$#L$#L$!L!#L&#L!!L$!L$%L!!L&!L$#L$#L$!L$!L&%L$!L&!L$#L&#L&!L&!L&%L)$L+%L)$L-%L/!L1!L9#LG#LR=!La1#L$!La2#LR:!LF#L8#L.!L0!L*%L($L(%L($L%%L%!L#!L%#L##L%!L#!L!%L%!L#!L!#L##L#!L#!L!%L#!L!!L##L!#L#!L!#L##L!!L#!L!%L!!L#!L!%L!!L#!L!%L!!L#!L!%L!!L!!L#%L!!L!#L!#L##L!!L!#L!#L!#L##L!#L$#L#!L#%L$#L!#L##L$#L#%L$!L#%L!%L$#L#%L$#L#(L$#L!(L!%L!%L$*L!(L$(L!,L$,L&.L$0L$4L):L+IL/R.L=U<LWNg@Z',
  false,
);
export const FRAME_WINDOW = /* @__PURE__ */ unpackPath(
  'MRdh7Y]6LRdo%Yz$LWNg@L=U<L/R.L+IL):L$4L$0L&.L$,L!,L$(L!(L$*L!%L!%L!(L$#L#(L$#L#%L$#L!%L#%L$!L#%L$#L##L!#L$#L#%L#!L$#L!#L##L!#L!#L!#L!!L##L!#L!#L!!L#%L!!L!!L!%L#!L!!L!%L#!L!!L!%L#!L!!L!%L#!L!!L##L!#L#!L!#L##L!!L#!L!%L#!L#!L##L!#L#!L%!L!%L#!L%!L##L%#L#!L%!L%%L($L(%L($L*%L0!L.!L8#LF#LR:!La2#L$!La1#LR=!LG#L9#L1!L/!L-%L)$L+%L)$L&%L&!L&!L&#L$#L&!L$!L&%L$!L$!L$#L$#L&!L!!L$%L$!L!!L&#L!#L$!L$#L$#L!!L$!L$%L$!L!!L!%L&!L!!L$%L!!L$!L!%L$!L$!L$%L!!L!#L$#L$#L!!L$#L$#L!#L$#L!#L$#L$!L!%L$#L!#L$#L$#L!%L$!L$%L$%L!#L$%L$#L!(L$#L&(L!%L$%L$*L$(L&(L$,L$,L&.L)0L&4L):L+IL3R.L;U<LX$g@L!!LWKgBL<U=L.R/L*JL(;L#5L#1L%/L#-L!-L#)L!)L#+L!&L!&L!)L#$L$)L#$L$&L#$L!&L$&L#!L$&L#$L$$L!$L#$L$&L$!L#$L!$L$$L!$L!$L!$L!!L$$L!$L!$L!!L$&L!!L!!L!&L$!L!!L!&L$!L!!L!&L$!L!!L!&L$!L!!L$$L!$L$!L!$L$$L!!L$!L!&L$!L$!L$$L!$L$!L&!L!&L$!L&!L$$L&$L$!L&!L&&L)#L)&L)#L+&L1!L/!L9$LG$LR;!La3$L#!La0$LR<!LF$L8$L0!L.!L,&L(#L*&L(#L%&L%!L%!L%$L#$L%!L#!L%&L#!L#!L#$L#$L%!L!!L#&L#!L!!L%$L!$L#!L#$L#$L!!L#!L#&L#!L!!L!&L%!L!!L#&L!!L#!L!&L#!L#!L#&L!!L!$L#$L#$L!!L#$L#$L!$L#$L!$L#$L#!L!&L#$L!$L#$L#$L!&L#!L#&L#&L!$L#&L#$L!)L#$L%)L!&L#&L#+L#)L%)L#-L#-L%/L(1L%5L(;L*JL2R/L:U=Z',
  false,
);
export const FRAME_EXIT = /* @__PURE__ */ unpackPath('MRee/Wi<QRdp4Wi=#p(Q!![Gb6Lz<Ua1QsDe:Y<nOQ$$a5f(LaF!LyE{%Z', false);

/** viewBox of the whole logo (word + frame o). */
export const LOGO_VIEWBOX = '0.84 -155.61 464.44 203.89';
/** Square viewBox of the mark alone, optically centred (area centroid of frame, window and exit, a touch above the middle). */
export const MARK_VIEWBOX = '343.18 -102.07 124 124';

/** The logo as SVG markup (put inside <svg viewBox={LOGO_VIEWBOX}>). `ink` = the lettering's colour; `window` = null for one colour. */
export function logoPaths(ink: string, window: string | null = BRAND_ORANGE): string {
  return (
    (window ? `<path d="${FRAME_WINDOW}" fill="${window}"/>` : '') +
    `<path d="${LOGO_LETTERS}" fill="${ink}"/><path d="${FRAME_RING}" fill="${ink}" fill-rule="evenodd"/><path d="${FRAME_EXIT}" fill="${ink}"/>`
  );
}
/** The mark alone (the frame o) as SVG markup (inside <svg viewBox={MARK_VIEWBOX}>). */
export function markPaths(ink: string, window: string | null = BRAND_ORANGE): string {
  return (
    (window ? `<path d="${FRAME_WINDOW}" fill="${window}"/>` : '') +
    `<path d="${FRAME_RING}" fill="${ink}" fill-rule="evenodd"/><path d="${FRAME_EXIT}" fill="${ink}"/>`
  );
}

/** The lettering on light and on dark surfaces (in the app it follows the theme through currentColor). */
export const BRAND_INK = '#1b1a18';
export const BRAND_IVORY = '#ece8df';
/** The app icon tiles, top → bottom, and the frame o's colour on them (docs/brand/lampo-icon-*-1024.svg). */
export const ICON_TILE = {
  light: { from: '#fbf9f4', to: '#ece7dc', ink: BRAND_INK },
  dark: { from: '#1f1f23', to: '#0e0e10', ink: '#efebe3' },
} as const;
