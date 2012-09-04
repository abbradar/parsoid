/**
 * Generic attribute expansion handler.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */
var $ = require('jquery'),
	request = require('request'),
	events = require('events'),
	qs = require('querystring'),
	Util = require('./mediawiki.Util.js').Util,
	ParserFunctions = require('./ext.core.ParserFunctions.js').ParserFunctions,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js')
									.AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js');


function AttributeExpander ( manager, options ) {
	this.manager = manager;
	this.options = options;
	// XXX: only register for tag tokens?
	manager.addTransform( this.onToken.bind(this), "AttributeExpander:onToken",
			this.rank, 'any' );
}

// constants
AttributeExpander.prototype.rank = 1.11;

/**
 * Token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 */
AttributeExpander.prototype.onToken = function ( token, frame, cb ) {
	// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
	if ( (token.constructor === TagTk ||
			token.constructor === SelfclosingTagTk) &&
				token.attribs &&
				token.attribs.length ) {
		// clone the token
		token = token.clone();
		var atm = new AttributeTransformManager(
					this.manager,
					{ wrapTemplates: this.options.wrapTemplates },
					this._returnAttributes.bind( this, token, cb )
				);
		cb( { async: true } );
		atm.process(token.attribs);
	} else {
		cb ( { tokens: [token] } );
	}
};

/* ----------------------------------------------------------
 * This method does two different things:
 *
 * 1. Strips all meta tags
 *    (FIXME: should I be selective and only strip mw:Object/* tags?)
 * 2. In wrap-template mode, it identifies the meta-object type
 *    and returns it.
 * ---------------------------------------------------------- */
function stripMetaTags(tokens, wrapTemplates) {
	var buf = [],
		wikitext = [],
		metaObjTypes = [],
		inTemplate = false;

	for (var i = 0, l = tokens.length; i < l; i++) {
		var token = tokens[i];
		if ([TagTk, SelfclosingTagTk].indexOf(token.constructor) !== -1) {
			// Strip all meta tags.
 			// SSS FIXME: should I be selective and only strip mw:Object/* tags?
			if (wrapTemplates) {
				// If we are in wrap-template mode, extract info from the meta-tag
				var t = token.getAttribute("typeof");
				var typeMatch = t && t.match(/(mw:Object(?:\/.*)?$)/);
				if (typeMatch) {
					inTemplate = !(typeMatch[1].match(/\/End$/));
					if (inTemplate) {
						metaObjTypes.push(typeMatch[1]);
						wikitext.push(token.dataAttribs.src);
					}
				} else {
					buf.push(token);
				}
			}
			
			// Dont strip token if it is not a meta-tag
			if (token.name !== "meta") {
				buf.push(token);
			}
		} else {
			// Assumes that non-template tokens are always text.
			// In turn, based on assumption that HTML attribute values
			// cannot contain any HTML (SSS FIXME: Isn't this true?)
			if (!inTemplate) {
				wikitext.push(token);
			}
			buf.push(token);
		}
	}

	return {
		// SSS FIXME: Assumes that either the attr. has only 1 expansion
		// OR all expansions are of the same type.
		// Consider the attr composed of pieces: s1, s2, s3
		// - s1 can be generated by a template
		// - s2 can be plain text
		// - s3 can be generated by an extension.
		// While that might be considered utter madness, there is nothing in
		// the spec right now that prevents this.  In any case, not sure
		// we do require all expandable types to be tracked.
		metaObjType: metaObjTypes[0],
		wikitext: Util.tokensToString(wikitext),
		value: buf
	};
}

/**
 * Callback for attribute expansion in AttributeTransformManager
 */
AttributeExpander.prototype._returnAttributes = function ( token, cb, newAttrs )
{
	this.manager.env.dp( 'AttributeExpander._returnAttributes: ', newAttrs );

	var tokens      = [];
	var metaTokens  = [];
	var oldAttrs    = token.attribs;
	var i, l, metaObjType, producerObjType;

	// Identify attributes that were generated in full or in part using templates
	// and add appropriate meta tags for them.
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		var a    = oldAttrs[i];
		var newK = newAttrs[i].k;

		if (newK) {
			// SSS FIXME: Do we need to figure out that this is a valid html attribute name
			// before stripping??  What a pain!  Or, am I over-engineering this?
			if (a.k.constructor === Array) {
				var updatedK = stripMetaTags(newK, this.options.wrapTemplates);
				newK = updatedK.value;
				newAttrs[i].k = newK;
				metaObjType = updatedK.metaObjType;
				if (metaObjType) {
					// SSS FIXME: Assumes that all expanded attrs. have the same expandable type
					// - attr1 can be expanded by a template
					// - attr2 can be expanded by an extension
					// While that might be considered madness, there is nothing in the spec right
					// not that prevents this.  In any case, not sure we do require all
					// expandable types to be tracked.
					producerObjType = metaObjType;
					// <meta about="#mwt1" property="mw:objectAttr#href" data-parsoid="...">
					// about will be filled out in the end
					metaTokens.push(new SelfclosingTagTk('meta',
						[new KV("property", "mw:objectAttrKey#" + newK)],
						{ src: updatedK.wikitext })
					);
				}
			}

			var isHtmlAttrKey = newK.constructor === String && !newK.match(/^mw:/);
			if (isHtmlAttrKey && a.v.constructor === Array) {
				var updatedV = stripMetaTags(newAttrs[i].v, this.options.wrapTemplates);
				newAttrs[i].v = updatedV.value;
				metaObjType = updatedV.metaObjType;
				if (metaObjType) {
					// SSS FIXME: Assumes that all expanded attrs. have the same expandable type
					// - attr1 can be expanded by a template
					// - attr2 can be expanded by an extension
					// While that might be considered madness, there is nothing in the spec right
					// not that prevents this.  In any case, not sure we do require all
					// expandable types to be tracked.
					producerObjType = metaObjType;
					if (newK.constructor !== String) {
						newK = Util.tokensToString(newK);
					}
					// <meta about="#mwt1" property="mw:objectAttr#href" data-parsoid="...">
					// about will be filled out in the end
					metaTokens.push(new SelfclosingTagTk('meta',
						[new KV("property", "mw:objectAttrVal#" + newK)],
						{ src: updatedV.wikitext })
					);
				}
			}
		}
	}

	// Update attrs
	token.attribs = newAttrs;

	// Update metatoken info
	l = metaTokens.length;
	if (l > 0) {
		var tokenId = '#mwt' + this.manager.env.generateUID();
		token.addAttribute("about", tokenId);
		token.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs/" + producerObjType.substring("mw:Object/".length));
		for (i = 0; i < l; i++) {
			metaTokens[i].addAttribute("about", tokenId);
		}
	}

	tokens = metaTokens;
	tokens.push(token);

	cb( { tokens: tokens } );
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
