/**
 * Line icons from the design (Kit.dc.html; 24 x 24, round caps). All are
 * decorative (aria-hidden): every control that uses one also carries a text
 * label.
 */
import type { ReactElement, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number; strokeWidth?: number };

function Svg({ size = 22, strokeWidth = 1.8, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

/** The compass: the Hunts tab. */
export const CompassIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
  </Svg>
);

/** The bidder's paddle: the Bids tab is about bidding. */
export const PaddleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="5.5" />
    <path d="M12 13.5V22" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Svg>
);

/** The trail: distance, and where you set out from. */
export const TrailIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 21c0-5 12-4 12-9s-8-4-8-9" strokeDasharray="2.5 3.5" />
    <circle cx="10" cy="3.5" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);

/** The truck: pickup. */
export const TruckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 6h12v10H2z" />
    <path d="M14 10h4l3 3v3h-7" />
    <circle cx="6.5" cy="17.5" r="2" />
    <circle cx="17" cy="17.5" r="2" />
  </Svg>
);

/** The manifest (Kit.dc.html): a list of what is in it, for a sale of many lots. */
export const ManifestIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="17" rx="2" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </Svg>
);

/** The price tag: fees and costs. */
export const PriceIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11.5V4h7.5L21 14.5 13.5 22z" />
    <circle cx="7.5" cy="8" r="1.5" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M16 6l-4-4-4 4" />
    <path d="M12 2v13" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17L17 7" />
    <path d="M8 7h9v9" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="14" rx="2" />
    <circle cx="12" cy="13" r="3.5" />
    <path d="M8 6l1.5-2h5L16 6" />
  </Svg>
);

export const FilterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Svg>
);
