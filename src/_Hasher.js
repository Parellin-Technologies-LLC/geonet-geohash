/** ****************************************************************************************************
 * File: _Hasher.js
 * Project: geohash
 * @author Nick Soggin <iSkore@users.noreply.github.com> on 14-Dec-2018
 *******************************************************************************************************/
'use strict';

const
	Readable                   = require( 'stream' ).Readable,
	geohash                    = require( 'ngeohash' ),
	Polygon                    = require( './Polygon' ),
	// turfExtent                 = require( 'turf-extent' ),
	{
		polygon: turfPolygon,
		featureCollection: turfFeaturecollection
	}                          = require( '@turf/helpers' ),
	{ default: bbox }          = require( '@turf/bbox' ),
	{ default: turfIntersect } = require( '@turf/intersect' ),
	through2                   = require( 'through2' ),
	geojsonArea                = require( 'geojson-area' );

/**
 * utilizing point-in-poly but providing support for geojson polys and holes.
 */
function inside( pt, poly ) {
	if( poly.type !== 'Polygon' && poly.type !== 'MultiPolygon' ) {
		return false;
	}
	
	const shape = poly.type === 'Polygon' ? [ poly.coordinates ] : poly.coordinates;
	let inside  = 0;
	
	shape.forEach(
		_poly => _poly.forEach(
			ring => !Polygon.pointInside( [ pt.longitude, pt.latitude ], ring ) || inside++
		)
	);
	
	return inside % 2;
}


/*
 * Hasher, extends Readable
 * a stream that will provide a readable list of hashes, row by row.
 *
 * Calculate geohashes of specified precision that cover the (Multi)Polygon provided
 * Note, duplicates may occur.
 */
class Hasher
{
	constructor( options = {} )
	{
		const defaults = {
			precision: options.integerMode ? 32 : 6,
			rowMode: false,
			integerMode: false,
			geojson: [],
			splitAt: 2000,
			hashMode: 'inside',
			threshold: 0,
			...options
		};
		
		for( const attrname in defaults ) {
			this[ attrname ] = options.hasOwnProperty( attrname ) &&
			( !!options[ attrname ] || options[ attrname ] === false ) ?
				options[ attrname ] :
				defaults[ attrname ];
		}
		
		this.hashes = [];
		
		this.isMulti = Array.isArray( this.geojson[ 0 ][ 0 ][ 0 ] );
		this.geojson = !this.isMulti ? [ this.geojson ] : this.geojson;
		this.geojson = this.geojson.map( turfPolygon );
		
		this.geohashEncode     = geohash.encode;
		this.geohashDecode     = geohash.decode;
		this.geohashDecodeBbox = geohash.decode_bbox;
		this.geohashNeighbor   = geohash.neighbor;
	}
	
	calculate()
	{
		while( this.geojson.length ) {
			const hashes = this.getNextRow() || [];
			this.hashes.push( ...hashes );
		}
		
		return this.hashes;
	}
	
	makeRow( currentGeojson )
	{
		if( !this.rowHash ) {
			this.rowHash = this.geohashEncode( this.bounding[ 2 ], this.bounding[ 1 ], this.precision );
		}
		
		let rowBox     = this.geohashDecodeBbox( this.rowHash, this.precision ),
			columnHash = this.rowHash,
			rowHashes  = [];
		
		const prepared = this.preparePoly( currentGeojson, rowBox );
		
		let
			columnCenter = this.geohashDecode( columnHash, this.precision ),
			westerly     = this.geohashNeighbor(
				this.geohashEncode(
					columnCenter.latitude,
					this.rowBounding[ 3 ],
					this.precision
				),
				[ 0, 1 ],
				this.precision
			);
		
		while( columnHash !== westerly ) {
			if( this.hashMode === 'inside' && inside( columnCenter, prepared ) ) {
				rowHashes.push( columnHash );
			} else if( this.hashMode === 'intersect' || this.hashMode === 'extent' ) {
				rowHashes.push( columnHash );
			}
			columnHash   = this.geohashNeighbor( columnHash, [ 0, 1 ], this.precision );
			columnCenter = this.geohashDecode( columnHash, this.precision );
		}
		
		const southNeighbour = this.geohashNeighbor( this.rowHash, [ -1, 0 ], this.precision );
		
		// Check if the current rowHash was already the most southerly hash on the map.
		// Also check if we are at or past the bottom of the bounding box.
		if( southNeighbour === this.rowHash || rowBox[ 0 ] <= this.bounding[ 0 ] ) {
			this.geojson.pop();
			this.rowHash     = null;
			this.bounding    = null;
			this.rowBounding = null;
		} else {
			this.rowHash = southNeighbour;
		}
		
		if( this.hashMode === 'inside' || this.hashMode === 'extent' || !rowHashes.length ) {
			return rowHashes;
		} else if( this.hashMode === 'intersect' ) {
			
			let baseArea = null;
			
			return rowHashes.filter(
				h => {
					let bb = this.geohashDecodeBbox( h, this.precision );
					bb     = turfPolygon( [ [
						[ bb[ 1 ], bb[ 2 ] ],
						[ bb[ 3 ], bb[ 2 ] ],
						[ bb[ 3 ], bb[ 0 ] ],
						[ bb[ 1 ], bb[ 0 ] ],
						[ bb[ 1 ], bb[ 2 ] ]
					] ] );
					
					if( !baseArea ) {
						baseArea = geojsonArea.geometry( bb.geometry );
					}
					
					const intersected    = turfIntersect( prepared, bb );
					let keepIntersection = !this.threshold;
					
					if(
						this.threshold &&
						intersected &&
						(
							intersected.geometry.type === 'Polygon' ||
							intersected.geometry.type === 'MultiPolygon'
						)
					) {
						const intersectedArea = geojsonArea.geometry( intersected.geometry );
						keepIntersection      = baseArea && intersectedArea / baseArea >= this.threshold;
					}
					
					return keepIntersection;
				}
			);
		}
	}
	
	/**
	 * getNextRow()
	 * will get the next row of geohashes for the current length-1 polygon in the list.
	 * only uses the current row bounds for checking pointinpoly
	 * rowHash persists so that it is available on the next iteration while the poly is still the same
	 */
	getNextRow()
	{
		const
			currentGeojson = this.geojson[ this.geojson.length - 1 ];
		
		if( !this.bounding ) {
			const extent = bbox( turfFeaturecollection( [ currentGeojson ] ) );
			
			// extent = [minX, minY, maxX, maxY], remap to match geohash lib
			this.bounding    = [ extent[ 1 ], extent[ 0 ], extent[ 3 ], extent[ 2 ] ];
			this.rowBounding = this.bounding.slice( 0 );
			return this.makeRow( currentGeojson );
		} else {
			return this.makeRow( currentGeojson );
		}
	}
	
	preparePoly( currentGeojson, rowBox )
	{
		// Detect poly length
		if( this.hashMode !== 'extent' && currentGeojson.geometry.coordinates[ 0 ].length >= this.splitAt ) {
			const rowBuffer = 0.0002;
			
			const
				clipper      = turfPolygon( [ [
					[ this.bounding[ 1 ] - rowBuffer, rowBox[ 2 ] + rowBuffer ], // nw
					[ this.bounding[ 3 ] + rowBuffer, rowBox[ 2 ] + rowBuffer ], // ne
					[ this.bounding[ 3 ] + rowBuffer, rowBox[ 0 ] - rowBuffer ], // se
					[ this.bounding[ 1 ] - rowBuffer, rowBox[ 0 ] - rowBuffer ], // sw
					[ this.bounding[ 1 ] - rowBuffer, rowBox[ 2 ] + rowBuffer ]  // nw
				] ] ),
				intersection = turfIntersect(
					turfFeaturecollection( [ clipper ] ),
					turfFeaturecollection( [ currentGeojson ] )
				);
			
			if( intersection && intersection.features.length ) {
				// Calculate the row bounding and column hash based on the intersection
				const
					intersectionFeature = {
						type: 'Feature',
						geometry: intersection.features[ 0 ],
						properties: {}
					},
					extent              = bbox( turfFeaturecollection( [ intersectionFeature ] ) );
				
				// extent = [minX, minY, maxX, maxY], remap to match geohash lib
				
				this.rowBounding = [ extent[ 1 ], extent[ 0 ], extent[ 3 ], extent[ 2 ] ];
				
				const
					midY = this.rowBounding[ 0 ] + ( this.rowBounding[ 2 ] - this.rowBounding[ 0 ] ) / 2;
				
				this.rowHash = this.geohashEncode( midY, this.rowBounding[ 1 ], this.precision );
				return intersection.features[ 0 ];
			} else {
				return currentGeojson.geometry;
			}
		} else {
			return currentGeojson.geometry;
		}
	}
}


/**
 * intializes the Hasher, but processes the results before returning an array.
 */
module.exports = options => {
	options.rowMode = true;
	
	const hasher = new Hasher( {
		geojson: options.coords,
		precision: options.precision,
		rowMode: !!options.rowMode,
		integerMode: !!options.integerMode,
		hashMode: options.hashMode,
		threshold: options.threshold || 0
	} );
	
	return hasher.calculate();
};